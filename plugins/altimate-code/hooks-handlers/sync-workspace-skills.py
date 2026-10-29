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

Runs under an exclusive lock on the skills directory itself, so concurrent
sessions and background refreshes reconcile one at a time.

`--withdraw` removes every copy (copying turned off). `--owned` only answers,
by exit status, whether the snapshot may be served to the signed-in account;
`--account` prints that account's digest (empty when signed out).

Prints `changed` when it wrote or removed anything. Never raises: a failure
leaves existing copies as they were.
"""

import fcntl
import filecmp
import hashlib
import json
import os
import re
import shutil
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
STAGING_PATTERN = re.compile(r"^\.[a-z0-9][a-z0-9-]{0,63}\.altimate-staging-[a-z0-9_]{8}(\.old)?$")
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


def signed_in_as():
    """(tenant, URL, account) of the signed-in Altimate account, or None. The account is
    the CLI's credential digest, which it records in the manifest it writes."""
    try:
        with open(CREDENTIALS, encoding="utf-8") as f:
            creds = json.load(f)
        # As the CLI reads them: `${env:VAR}` resolved (a missing variable is no sign-in), URL without trailing slashes.
        tenant, url, key = (
            ENV_REFERENCE.sub(lambda m: os.environ[m.group(1)], creds.get(field))
            for field in ("altimateInstanceName", "altimateUrl", "altimateApiKey")
        )
        if not (tenant and key):
            return None
        url = url.rstrip("/")
        return tenant, url, hashlib.sha256(f"{url}|{tenant}|{key}".encode()).hexdigest()
    except (OSError, ValueError, AttributeError, TypeError, KeyError):
        return None


def owner_of(manifest):
    return manifest.get("tenant"), str(manifest.get("apiUrl", "")).rstrip("/"), manifest.get("account")


def snapshot_is_ours(project):
    if os.path.islink(os.path.join(project, SNAPSHOT_DIR)):
        return False
    try:
        manifest = json.loads(read_text_no_follow(os.path.join(project, SNAPSHOT_DIR, MANIFEST)))
        return owner_of(manifest) == signed_in_as()
    except (OSError, ValueError, AttributeError, TypeError):
        return False


def cli_is_swapping(project):
    """True while the CLI has moved the live snapshot aside to swap a new one in. Judged by
    ctime: the rename that retires the snapshot updates it, but keeps the old mtime."""
    staging = os.path.join(project, CLI_STAGING_DIR)
    try:
        return any(
            entry.startswith("retired-") and time.time() - os.lstat(os.path.join(staging, entry)).st_ctime < SWAP_SECONDS
            for entry in os.listdir(staging)
        )
    except OSError:
        return False


def read_text_no_follow(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with open(fd, encoding="utf-8") as f:
        return f.read()


def read_snapshot(project):
    """[(source dir, name, description, body)] for each usable workspace skill;
    [] when the project has no snapshot or it belongs to another account, so copies
    are removed; None when the snapshot cannot be read or the CLI is swapping it, so
    nothing changes."""
    root = os.path.join(project, SNAPSHOT_DIR)
    manifest_path = os.path.join(root, MANIFEST)
    if not os.path.lexists(manifest_path):
        return None if cli_is_swapping(project) else []
    if os.path.islink(root):
        return None
    try:
        manifest = json.loads(read_text_no_follow(manifest_path))
        ids = list(manifest.get("skills", {}))
        owner = owner_of(manifest)
    except (OSError, ValueError, AttributeError, TypeError):
        return None
    if owner != signed_in_as():
        return []
    skills = []
    for skill_id in ids:
        # Each id is one directory under the snapshot, never a path out of it.
        if not isinstance(skill_id, str) or not skill_id or skill_id.startswith(".") or "/" in skill_id or "\\" in skill_id:
            continue
        source = os.path.join(root, skill_id)
        if os.path.islink(source) or not os.path.isdir(source):
            continue
        skill_file = os.path.join(source, "SKILL.md")
        if not os.path.lexists(skill_file) or os.path.islink(skill_file):
            continue
        try:
            fields, body = parse_frontmatter(read_text_no_follow(skill_file))
        except UnicodeDecodeError:
            continue
        except OSError:
            return None
        if not fields:
            continue
        name, description = fields.get("name", ""), fields.get("description", "")
        if NAME_PATTERN.match(name) and description:
            skills.append((source, name, description, body))
    return skills


def is_ours(path):
    """A marked, non-symlinked directory whose marker names it. Markers without a name
    (written by the CLI) still count; a copy the user renamed does not."""
    if os.path.islink(path):
        return False
    try:
        with open(os.path.join(path, MARKER), encoding="utf-8") as f:
            marker = f.read()
    except (OSError, UnicodeDecodeError):
        return False
    names = [line[len("skill: ") :] for line in marker.splitlines() if line.startswith("skill: ")]
    return not names or names[0] == os.path.basename(path)


def is_blocked_dir(name):
    return name.startswith(".") or name.lower() in BLOCKED_DIRS


def build_copy(source, name, description, body, staging):
    # First, so a copy interrupted part-way is still kept out of git.
    with open(os.path.join(staging, ".gitignore"), "w", encoding="utf-8") as f:
        f.write("*\n")
    for dirpath, dirnames, filenames in os.walk(source):
        dirnames[:] = [
            d for d in dirnames if not os.path.islink(os.path.join(dirpath, d)) and not is_blocked_dir(d)
        ]
        rel = os.path.relpath(dirpath, source)
        os.makedirs(os.path.join(staging, rel), exist_ok=True)
        for filename in filenames:
            src = os.path.join(dirpath, filename)
            if os.path.islink(src) or filename.startswith(".") or filename.lower() in BLOCKED_FILES:
                continue
            shutil.copy(src, os.path.join(staging, rel, filename))
    rendered = render_skill(name, description, body)
    if has_command_marker(rendered.split("\n---\n", 1)[1]):
        raise ValueError(f"workspace skill {name} still has a command marker")
    with open(os.path.join(staging, "SKILL.md"), "w", encoding="utf-8") as f:
        f.write(rendered)
    with open(os.path.join(staging, MARKER), "w", encoding="utf-8") as f:
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
    if os.path.islink(os.path.join(project, ".claude")) or os.path.islink(target_root):
        return False
    if not os.path.isdir(target_root):
        # Nothing to remove; create the directory only when there is something to copy.
        if withdraw or not read_snapshot(project):
            return False
        os.makedirs(target_root, exist_ok=True)
    lock = os.open(target_root, os.O_RDONLY)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        remove_abandoned_staging(target_root)
        return reconcile(project, target_root, [] if withdraw else read_snapshot(project))
    finally:
        os.close(lock)


def remove_abandoned_staging(target_root):
    """Staging directories (`.<name>.XXXX`, `.<name>.XXXX.old`) left by a sync that was killed.
    Only our staging names match, and under the lock no other sync of ours runs; the age is a
    margin for a sync that has not taken the lock yet."""
    for entry in os.listdir(target_root):
        path = os.path.join(target_root, entry)
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


def reconcile(project, target_root, skills):
    if skills is None:
        return False
    changed = False
    wanted = set()
    for source, name, description, body in skills:
        if name in wanted:
            continue
        target = os.path.join(target_root, name)
        if os.path.lexists(target) and not is_ours(target):
            continue
        wanted.add(name)
        staging = tempfile.mkdtemp(prefix=f".{name}{STAGING_INFIX}", dir=target_root)
        try:
            try:
                build_copy(source, name, description, body, staging)
            except (OSError, ValueError) as err:
                print(f"altimate-code plugin: skipped workspace skill {name}: {err}", file=sys.stderr)
                continue
            if os.path.isdir(target) and same_tree(staging, target):
                continue
            try:
                replace_dir(staging, target)
            except OSError as err:
                print(f"altimate-code plugin: could not update workspace skill {name}: {err}", file=sys.stderr)
                continue
            changed = True
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    if os.path.isdir(target_root):
        for entry in os.listdir(target_root):
            path = os.path.join(target_root, entry)
            # Staging directories start with "." and never match.
            if NAME_PATTERN.match(entry) and entry not in wanted and is_ours(path):
                shutil.rmtree(path, ignore_errors=True)
                changed = True
    return changed


def main():
    flags = {arg for arg in sys.argv[1:] if arg.startswith("--")}
    paths = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
    project = paths[0] if paths else os.getcwd()
    if "--account" in flags:
        identity = signed_in_as()
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
