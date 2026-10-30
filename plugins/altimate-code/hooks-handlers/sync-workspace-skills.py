#!/usr/bin/env python3
"""Mirror an Altimate workspace's skills into the project's Claude Code skills.

altimate-code keeps the linked workspace's skills in
`<project>/.altimate-code/skill/_workspace/<id>/`. This copies each one into
`<project>/.claude/skills/<name>/`, where Claude Code discovers project skills.

Copies are reduced to what describes a skill. Claude Code honours frontmatter
that pre-approves tools (`allowed-tools`) or registers hooks (`hooks`), and runs
`!` command blocks in the body when a skill loads; a workspace skill is written
by whoever can upload to the workspace, so none of that is carried over: the
frontmatter keeps only `name` and `description`, no `!` is left next to a
backtick or fence, and the bundle's other files are copied except the paths
Claude Code reads as skills, hooks or other plugin components.

Like altimate-code, it only serves a snapshot fetched for the Altimate account
the user is signed in to (tenant, URL and a digest of the API key, as the CLI
checks); otherwise, or when the project has no snapshot or the workspace has no
skills, the copies are removed. A snapshot that exists but cannot be read, or is
missing because the CLI is swapping in a new one, changes nothing.

Ownership: a copied directory holds MARKER, naming the skill. Only marked
directories are replaced or removed, so a skill the user wrote with the same
name is never touched; that workspace skill is skipped instead. A marked copy
under another name (a user's renamed copy) is not ours either. Each copy has a `.gitignore`
of `*`, so copies stay out of version control.

Runs under a lock shared with the CLI's own copy (claude-skill-mirror.ts): an
atomic `mkdir` of SKILLS_DIR/LOCK_DIR, the one lock both runtimes have. The
holder renews it; one not renewed for LOCK_STALE_SECONDS belongs to a sync that
died and is taken over; one that is not free within LOCK_WAIT_SECONDS leaves the
copies as they are. Copies are removed only while the manifest is the one read.

`--withdraw` removes every copy (copying turned off). `--owned` only answers,
by exit status, whether the snapshot may be served to the signed-in account;
`--account` prints that account's digest (empty when signed out).

Prints `changed` when it wrote or removed anything. Never raises: a failure
leaves existing copies as they were.
"""

import filecmp
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import time

SNAPSHOT_DIR = os.path.join(".altimate-code", "skill", "_workspace")
MANIFEST = ".manifest.json"
SKILLS_DIR = os.path.join(".claude", "skills")
MARKER = ".altimate-workspace-skill"
MARKER_TEXT = "Copied from the linked Altimate workspace by the altimate-code plugin. Edits here are replaced.\n"
SNAPSHOT_META = {MANIFEST, ".gitignore", ".synced-at"}
# Where the CLI moves the live snapshot aside while it swaps a new one in.
CLI_STAGING_DIR = os.path.join(".altimate-code", "skill-staging")
SWAP_SECONDS = 600
# Staging directories: tempfile.mkdtemp(prefix=".<name>.altimate-staging-"), and the ".old" a swap
# moves the previous copy to. The infix keeps a user's own hidden directories from ever matching.
STAGING_INFIX = ".altimate-staging-"
STAGING_PATTERN = re.compile(r"^\.[a-z0-9][a-z0-9-]{0,63}\.altimate-staging-[A-Za-z0-9_]{6,8}(\.old)?$")
LOCK_DIR = ".altimate-workspace-sync.lock"
LOCK_STALE_SECONDS = 120
LOCK_WAIT_SECONDS = 10
# Claude Code skill names: lowercase letters, digits and hyphens.
NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
CREDENTIALS = os.path.join(os.path.expanduser("~"), ".altimate", "altimate.json")
ENV_REFERENCE = re.compile(r"\$\{env:([^}]+)\}")
# `!` before a backtick starts an inline command; `!` right after a fence opens a command block.
BANG_BEFORE_BACKTICK = re.compile(r"!(?=`)")
BANG_AFTER_FENCE = re.compile(r"(`{3,}|~{3,})!+")
# Paths Claude Code reads as configuration or components when found in a skills directory or plugin.
# Compared lowercased: default macOS and Windows filesystems ignore case.
BLOCKED_DIRS = {"hooks", "skills", "agents", "commands", "output-styles", "monitors", "bin"}
BLOCKED_FILES = {
    "skill.md", "claude.md", "claude.local.md", ".mcp.json", ".lsp.json",
    "settings.json", "settings.local.json", "plugin.json", "hooks.json",
}


def parse_frontmatter(text):
    """Return ({key: value} for top-level scalar keys, body). Handles plain,
    quoted and block (`|`, `>`) scalars, which is what skill names and
    descriptions use."""
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return None, text
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    except StopIteration:
        return None, text
    fields = {}
    i = 1
    while i < end:
        match = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", lines[i])
        i += 1
        if not match:
            continue
        key, raw = match.group(1), match.group(2).strip()
        if raw[:1] in ("|", ">"):
            block = []
            while i < end and (not lines[i].strip() or lines[i][:1] in (" ", "\t")):
                block.append(lines[i].strip())
                i += 1
            joined = "\n" if raw[0] == "|" else " "
            fields[key] = joined.join(part for part in block if part).strip()
        elif raw[:1] in ('"', "'") and raw[-1:] == raw[:1] and len(raw) > 1:
            inner = raw[1:-1]
            fields[key] = inner.replace("''", "'") if raw[0] == "'" else inner.replace('\\"', '"')
        else:
            fields[key] = raw
    return fields, "\n".join(lines[end + 1 :])


def neutralise_commands(body):
    """Leave no `!` touching a backtick or fence, so no form of command block survives.
    Repeated until stable: one rewrite can form a new marker from its neighbours."""
    while True:
        cleaned = BANG_BEFORE_BACKTICK.sub("! ", BANG_AFTER_FENCE.sub(r"\1", body))
        if cleaned == body:
            return cleaned
        body = cleaned


def has_command_marker(text):
    return bool(BANG_BEFORE_BACKTICK.search(text) or BANG_AFTER_FENCE.search(text))


def render_skill(name, description, body):
    return f"---\nname: {name}\ndescription: {json.dumps(description)}\n---\n{neutralise_commands(body)}"


class Unreadable(Exception):
    """The snapshot or the credentials exist but cannot be read: nothing is changed."""


def signed_in_as():
    """(tenant, URL, account) of the signed-in Altimate account, or None when signed out.
    Raises Unreadable when the credentials exist but cannot be read. The account is the
    CLI's credential digest, which it records in the manifest it writes."""
    try:
        with open(CREDENTIALS, encoding="utf-8") as f:
            creds = json.load(f, parse_constant=reject_constant)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as err:
        raise Unreadable(err) from err
    if not isinstance(creds, dict):
        raise Unreadable("credentials are not an object")
    try:
        # As the CLI reads them: `${env:VAR}` resolved in every field, URL without trailing slashes.
        creds = resolve_env(creds)
        tenant, url, key = (creds[field] for field in ("altimateInstanceName", "altimateUrl", "altimateApiKey"))
        if not all(isinstance(value, str) for value in (tenant, url, key)):
            raise TypeError("a credential field is not a string")
    except (KeyError, TypeError) as err:  # an unset variable, or a field missing: the CLI cannot read them either
        raise Unreadable(err) from err
    if not key:  # the CLI checks only the key
        return None
    url = url.rstrip("/")
    return tenant, url, hashlib.sha256(f"{url}|{tenant}|{key}".encode()).hexdigest()


def resolve_env(value):
    if isinstance(value, str):
        return ENV_REFERENCE.sub(lambda m: os.environ[m.group(1)], value)
    if isinstance(value, list):
        return [resolve_env(v) for v in value]
    if isinstance(value, dict):
        return {k: resolve_env(v) for k, v in value.items()}
    return value


def reject_constant(name):
    raise ValueError(f"{name} is not JSON")  # NaN and Infinity: the CLI's JSON.parse rejects them


def owner_of(manifest):
    """The account a manifest was fetched for; None for one the CLI would not attribute
    (its readManifest checks)."""
    valid = (
        isinstance(manifest, dict)
        and manifest.get("version") == 2
        and type(manifest.get("datamateId")) in (int, float)
        and isinstance(manifest.get("tenant"), str)
        and isinstance(manifest.get("apiUrl"), str)
        and isinstance(manifest.get("account"), str)
        and manifest["account"]
        and isinstance(manifest.get("skills"), dict)
    )
    # apiUrl compared exactly, as the CLI does; it writes it without a trailing slash.
    return (manifest["tenant"], manifest["apiUrl"], manifest["account"]) if valid else None


def serves(manifest):
    """True when the manifest may be served to the signed-in account. Raises Unreadable."""
    owner, identity = owner_of(manifest), signed_in_as()
    return owner is not None and identity is not None and owner == identity


def is_link(path):
    """A symlink, or an NTFS junction (which islink does not report; os.path.isjunction is 3.12+)."""
    try:
        st = os.lstat(path)
    except OSError:
        return False
    junction = getattr(stat, "IO_REPARSE_TAG_MOUNT_POINT", None)
    return stat.S_ISLNK(st.st_mode) or (junction is not None and getattr(st, "st_reparse_tag", 0) == junction)


def read_text_no_follow(path, encoding="utf-8"):
    # O_NOFOLLOW does not exist on Windows; the callers' islink checks still apply there.
    # O_BINARY: Windows would otherwise stop a text-mode read at a \x1a byte.
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
    with open(fd, encoding=encoding) as f:
        return f.read()


def read_manifest(project):
    """(text, manifest) of the snapshot's manifest, or None when there is none.
    Raises Unreadable when it exists but cannot be read, or its path runs through a symlink."""
    parts = SNAPSHOT_DIR.split(os.sep) + [MANIFEST]
    if any(is_link(os.path.join(project, *parts[: i + 1])) for i in range(len(parts))):
        raise Unreadable("the snapshot path runs through a symlink")
    try:
        text = read_text_no_follow(os.path.join(project, SNAPSHOT_DIR, MANIFEST))
        manifest = json.loads(text, parse_constant=reject_constant)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as err:
        raise Unreadable(err) from err
    # A manifest that is not an object is readable but not attributable: owner_of says no.
    return text, manifest


def manifest_text_now(project):
    """The manifest's text as it is now, None without one, or a value equal to nothing when unreadable."""
    try:
        found = read_manifest(project)
    except Unreadable:
        return object()
    return found[0] if found else None


def snapshot_unchanged(project, manifest_text):
    """The manifest is the one read, and still belongs to the signed-in account (no sign-out or switch since)."""
    return manifest_text_now(project) == manifest_text and (manifest_text is None or snapshot_is_ours(project))


def snapshot_is_ours(project):
    try:
        found = read_manifest(project)
        return found is not None and serves(found[1])
    except Unreadable:
        return False


def cli_is_swapping(project):
    """True while the CLI has moved the live snapshot aside to swap a new one in: a `retired-*`
    entry, in a staging directory changed within SWAP_SECONDS. The rename into it updates the
    directory's mtime on every platform; the retired tree keeps its old mtime, and on Windows
    its ctime is the creation time."""
    staging = os.path.join(project, CLI_STAGING_DIR)
    try:
        return time.time() - os.lstat(staging).st_mtime < SWAP_SECONDS and any(
            entry.startswith("retired-") for entry in os.listdir(staging)
        )
    except OSError:
        return False


def read_snapshot(project):
    """(skills, manifest text), skills being [(source dir, name, description, body)].
    No skills when the project has no snapshot or it belongs to another account, so copies
    are removed. None, so nothing changes, when the snapshot or the credentials cannot be
    read, a listed skill directory is missing, or the CLI is swapping the snapshot."""
    try:
        found = read_manifest(project)
        if found is None:
            return None if cli_is_swapping(project) else ([], None)
        text, manifest = found
        if not serves(manifest):
            return [], text
    except Unreadable:
        return None
    root = os.path.join(project, SNAPSHOT_DIR)
    skills = []
    for skill_id in manifest["skills"]:  # owner_of checked it is an object
        # Each id is one directory under the snapshot, never a path out of it.
        if not isinstance(skill_id, str) or not skill_id or skill_id.startswith(".") or "/" in skill_id or "\\" in skill_id:
            continue
        source = os.path.join(root, skill_id)
        skill_file = os.path.join(source, "SKILL.md")
        # A listed directory that is gone means the snapshot changed under us; a skill
        # without a SKILL.md is skipped, as the CLI does.
        if not os.path.lexists(source):
            return None
        if is_link(source) or not os.path.isdir(source):
            continue
        try:
            # A skill without a regular SKILL.md (missing, a link, a directory) is skipped.
            if not stat.S_ISREG(os.lstat(skill_file).st_mode):
                continue
        except FileNotFoundError:
            continue
        except OSError:  # e.g. a directory that cannot be searched: unknown, so nothing is pruned
            return None
        try:
            # utf-8-sig: a byte-order mark is dropped, as the CLI's decoder does.
            fields, body = parse_frontmatter(read_text_no_follow(skill_file, "utf-8-sig"))
        except UnicodeDecodeError:
            continue
        except OSError:
            return None
        if not fields:
            continue
        name, description = fields.get("name", ""), fields.get("description", "")
        if NAME_PATTERN.fullmatch(name) and description:
            skills.append((source, name, description, body))
    return skills, text


def is_ours(path):
    """A marked, non-symlinked directory whose marker names it. Markers without a name
    (written by earlier versions) still count; a copy the user renamed does not."""
    if is_link(path):
        return False
    try:
        with open(os.path.join(path, MARKER), encoding="utf-8") as f:
            marker = f.read()
    except (OSError, UnicodeDecodeError):
        return False
    # Lines split on \r\n, \r or \n only, as the CLI does (splitlines also splits on U+2028 and others).
    names = [line[len("skill: ") :] for line in re.split(r"\r\n?|\n", marker) if line.startswith("skill: ")]
    return not names or names[0] == os.path.basename(path)


def is_blocked_dir(name):
    return name.startswith(".") or name.lower() in BLOCKED_DIRS


def raise_error(err):
    raise err


def build_copy(source, name, description, body, staging):
    # First, so a copy interrupted part-way is still kept out of git.
    # newline="\n": the same bytes on every platform, as the CLI writes them.
    with open(os.path.join(staging, ".gitignore"), "w", encoding="utf-8", newline="\n") as f:
        f.write("*\n")
    # onerror raises: an unreadable subdirectory skips the skill instead of copying part of it.
    for dirpath, dirnames, filenames in os.walk(source, onerror=raise_error):
        dirnames[:] = [
            d for d in dirnames if not is_link(os.path.join(dirpath, d)) and not is_blocked_dir(d)
        ]
        rel = os.path.relpath(dirpath, source)
        os.makedirs(os.path.join(staging, rel), exist_ok=True)
        for filename in filenames:
            src = os.path.join(dirpath, filename)
            # Regular files only, as the CLI copies: no symlinks, FIFOs or devices.
            if os.path.islink(src) or not os.path.isfile(src) or filename.startswith(".") or filename.lower() in BLOCKED_FILES:
                continue
            shutil.copy(src, os.path.join(staging, rel, filename))
    rendered = render_skill(name, description, body)
    if has_command_marker(rendered.split("\n---\n", 1)[1]):
        raise ValueError(f"workspace skill {name} still has a command marker")
    with open(os.path.join(staging, "SKILL.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write(rendered)
    with open(os.path.join(staging, MARKER), "w", encoding="utf-8", newline="\n") as f:
        f.write(f"{MARKER_TEXT}skill: {name}\n")


def same_tree(a, b):
    def file_sizes(root):
        sizes = {}
        for dirpath, _, filenames in os.walk(root):
            for filename in filenames:
                path = os.path.join(dirpath, filename)
                sizes[os.path.relpath(path, root)] = os.path.getsize(path)
        return sizes

    try:
        sizes = file_sizes(a)
        return sizes == file_sizes(b) and all(
            filecmp.cmp(os.path.join(a, rel), os.path.join(b, rel), shallow=False) for rel in sizes
        )
    except OSError:
        return False


def replace_dir(staging, target):
    """Move staging into target's place; on failure the old copy is put back."""
    if not os.path.isdir(target):
        os.rename(staging, target)
        return
    old = staging + ".old"
    os.rename(target, old)
    try:
        os.rename(staging, target)
    except OSError:
        os.rename(old, target)
        raise
    shutil.rmtree(old, ignore_errors=True)


def sync(project, withdraw=False):
    target_root = os.path.join(project, SKILLS_DIR)
    # A symlinked `.claude` or `.claude/skills` could point outside the project; never write or remove through it.
    if is_link(os.path.join(project, ".claude")) or is_link(target_root):
        return False
    if not os.path.isdir(target_root):
        # Nothing to remove; create the directory only when there is something to copy.
        snapshot = None if withdraw else read_snapshot(project)
        if not snapshot or not snapshot[0]:
            return False
        os.makedirs(target_root, exist_ok=True)
    lock = acquire_lock(target_root)
    if lock is None:
        return False
    try:
        remove_abandoned_staging(target_root)
        if withdraw:
            return reconcile(project, target_root, [], lock, check_manifest=False)
        snapshot = read_snapshot(project)
        if snapshot is None:
            return False
        return reconcile(project, target_root, snapshot[0], lock, manifest_text=snapshot[1])
    finally:
        release_lock(lock)


def acquire_lock(target_root):
    """(path, token) once this process holds the lock, or None when it is not free within
    LOCK_WAIT_SECONDS. Ownership is an empty `<token>` directory inside the lock, which git
    does not show and which no other holder can have."""
    path = os.path.join(target_root, LOCK_DIR)
    token = f"{os.getpid()}-{time.time_ns()}"
    deadline = time.time() + LOCK_WAIT_SECONDS
    while True:
        try:
            os.mkdir(path)
            os.mkdir(os.path.join(path, token))
            return path, token
        except FileExistsError:
            pass
        except OSError:
            return None
        break_stale_lock(path)
        if time.time() > deadline:
            return None
        time.sleep(0.05)


def break_stale_lock(path):
    """Remove a lock whose holder stopped renewing it. The rename lets one taker win. A lock
    renewed meanwhile goes back only while the path is free; otherwise its holder finds its
    token gone and stops."""
    tomb = f"{path}.stale-{os.getpid()}-{time.monotonic_ns()}"
    try:
        if time.time() - os.lstat(path).st_mtime <= LOCK_STALE_SECONDS:
            return
        os.rename(path, tomb)
        if time.time() - os.lstat(tomb).st_mtime <= LOCK_STALE_SECONDS and not os.path.lexists(path):
            os.rename(tomb, path)
            return
    except OSError:
        return
    remove_path(tomb)


def remove_path(path):
    """A directory with its contents, or a file."""
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path, ignore_errors=True)
    else:
        try:
            os.remove(path)
        except OSError:
            pass


def holds_lock(lock):
    path, token = lock
    return os.path.isdir(os.path.join(path, token)) and not is_link(path)


def renew_lock(lock):
    """Keep a held lock fresh, so a long sync is not taken for a dead one. False once it is lost."""
    if not holds_lock(lock):
        return False
    try:
        os.utime(lock[0])
    except OSError:
        pass
    return True


def release_lock(lock):
    """Remove the lock only while it is still this process's."""
    if holds_lock(lock):
        shutil.rmtree(lock[0], ignore_errors=True)


def remove_abandoned_staging(target_root):
    """Staging directories (`.<name>.altimate-staging-XXXXXX`, and `.old`) left by a sync
    that was killed. Only our staging names match, and under the lock no other sync runs;
    the age is a margin for a sync that has not taken the lock yet."""
    for entry in os.listdir(target_root):
        path = os.path.join(target_root, entry)
        if entry.startswith(LOCK_DIR + ".stale-") and not os.path.islink(path):
            # A lock taken over from a dead sync whose removal was interrupted.
            try:
                if time.time() - os.lstat(path).st_mtime > LOCK_STALE_SECONDS:
                    remove_path(path)
            except OSError:
                pass
            continue
        if not STAGING_PATTERN.match(entry) or os.path.islink(path) or not os.path.isdir(path):
            continue
        try:
            with open(os.path.join(path, ".gitignore"), encoding="utf-8") as f:
                if f.read() != "*\n":
                    continue
            if time.time() - os.lstat(path).st_mtime > SWAP_SECONDS:
                shutil.rmtree(path, ignore_errors=True)
        except OSError:
            pass


def reconcile(project, target_root, skills, lock, manifest_text=None, check_manifest=True):
    changed = False
    wanted = set()
    for source, name, description, body in skills:
        if name in wanted:
            continue
        target = os.path.join(target_root, name)
        if os.path.lexists(target) and not is_ours(target):
            continue
        wanted.add(name)
        if not renew_lock(lock):
            return changed  # taken over as dead: the new holder finishes the job
        staging = tempfile.mkdtemp(prefix=f".{name}{STAGING_INFIX}", dir=target_root)
        try:
            try:
                build_copy(source, name, description, body, staging)
            except (OSError, ValueError) as err:
                print(f"altimate-code plugin: skipped workspace skill {name}: {err}", file=sys.stderr)
                continue
            if os.path.isdir(target) and same_tree(staging, target):
                continue
            # Building can outlast the lock, and the snapshot can be swapped while it is copied:
            # either way nothing more is published; the next sync picks up the new state.
            if not renew_lock(lock) or (check_manifest and not snapshot_unchanged(project, manifest_text)):
                return changed
            try:
                replace_dir(staging, target)
            except OSError as err:
                print(f"altimate-code plugin: could not update workspace skill {name}: {err}", file=sys.stderr)
                continue
            changed = True
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    # Removal only for the snapshot read above: one swapped in meanwhile is the next sync's.
    if not renew_lock(lock) or (check_manifest and manifest_text_now(project) != manifest_text):
        return changed
    for entry in os.listdir(target_root):
        path = os.path.join(target_root, entry)
        # Staging and lock directories start with "." and never match.
        if NAME_PATTERN.fullmatch(entry) and entry not in wanted and is_ours(path):
            shutil.rmtree(path, ignore_errors=True)
            changed = True
    return changed


def main():
    flags = {arg for arg in sys.argv[1:] if arg.startswith("--")}
    paths = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
    project = paths[0] if paths else os.getcwd()
    if "--account" in flags:
        try:
            identity = signed_in_as()
        except Unreadable:
            identity = None
        print(identity[2] if identity else "")
        return
    if "--owned" in flags:
        sys.exit(0 if snapshot_is_ours(project) else 1)
    try:
        if sync(project, withdraw="--withdraw" in flags):
            print("changed")
    except Exception as err:  # never break session start
        print(f"altimate-code plugin: workspace skill copy failed: {err}", file=sys.stderr)


if __name__ == "__main__":
    main()
