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

Like altimate-code, it only serves a snapshot fetched for the Altimate tenant
the user is signed in to; otherwise, or when the workspace has no skills, the
copies are removed.

Ownership: a copied directory holds MARKER. Only marked directories are
replaced or removed, so a skill the user wrote with the same name is never
touched; that workspace skill is skipped instead. Each copy has a `.gitignore`
of `*`, so copies stay out of version control.

Prints `changed` when it wrote or removed anything. Never raises: a failure
leaves existing copies as they were.
"""

import json
import os
import re
import shutil
import sys
import tempfile

SNAPSHOT_DIR = os.path.join(".altimate-code", "skill", "_workspace")
MANIFEST = ".manifest.json"
SKILLS_DIR = os.path.join(".claude", "skills")
MARKER = ".altimate-workspace-skill"
SNAPSHOT_META = {MANIFEST, ".gitignore", ".synced-at"}
# Claude Code skill names: lowercase letters, digits and hyphens.
NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
CREDENTIALS = os.path.join(os.path.expanduser("~"), ".altimate", "altimate.json")
# `!` before a backtick starts an inline command; `!` right after a fence opens a command block.
BANG_BEFORE_BACKTICK = re.compile(r"!(?=`)")
BANG_AFTER_FENCE = re.compile(r"(`{3,}|~{3,})!")
# Paths Claude Code reads as configuration or components when found in a skills directory or plugin.
BLOCKED_DIRS = {"hooks", "skills", "agents", "commands", "output-styles", "monitors", "bin"}
BLOCKED_FILES = {"SKILL.md", ".mcp.json", ".lsp.json", "settings.json", "settings.local.json", "plugin.json", "hooks.json"}


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
    """Leave no `!` touching a backtick or fence, so no form of command block survives."""
    return BANG_BEFORE_BACKTICK.sub("! ", BANG_AFTER_FENCE.sub(r"\1", body))


def render_skill(name, description, body):
    return f"---\nname: {name}\ndescription: {json.dumps(description)}\n---\n{neutralise_commands(body)}"


def signed_in_as():
    try:
        with open(CREDENTIALS, encoding="utf-8") as f:
            creds = json.load(f)
        return creds.get("altimateInstanceName"), creds.get("altimateUrl", "").rstrip("/")
    except (OSError, ValueError, AttributeError):
        return None


def read_snapshot(project):
    """[(source dir, name, description, body)] for each usable workspace skill;
    [] when there is no snapshot for the signed-in tenant; None when it cannot be read."""
    root = os.path.join(project, SNAPSHOT_DIR)
    manifest_path = os.path.join(root, MANIFEST)
    if not os.path.exists(manifest_path):
        return []
    try:
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
        ids = list(manifest.get("skills", {}))
        owner = (manifest.get("tenant"), str(manifest.get("apiUrl", "")).rstrip("/"))
    except (OSError, ValueError, AttributeError):
        return None
    if owner != signed_in_as():
        return []
    skills = []
    for skill_id in ids:
        source = os.path.join(root, skill_id)
        if os.path.islink(source) or not os.path.isdir(source):
            continue
        try:
            with open(os.path.join(source, "SKILL.md"), encoding="utf-8") as f:
                fields, body = parse_frontmatter(f.read())
        except (OSError, UnicodeDecodeError):
            continue
        if not fields:
            continue
        name, description = fields.get("name", ""), fields.get("description", "")
        if NAME_PATTERN.match(name) and description:
            skills.append((source, name, description, body))
    return skills


def is_ours(path):
    return os.path.isfile(os.path.join(path, MARKER)) and not os.path.islink(path)


def is_blocked_dir(name):
    return name.startswith(".") or name in BLOCKED_DIRS


def build_copy(source, name, description, body, staging):
    for dirpath, dirnames, filenames in os.walk(source):
        dirnames[:] = [
            d for d in dirnames if not os.path.islink(os.path.join(dirpath, d)) and not is_blocked_dir(d)
        ]
        rel = os.path.relpath(dirpath, source)
        os.makedirs(os.path.join(staging, rel), exist_ok=True)
        for filename in filenames:
            src = os.path.join(dirpath, filename)
            if os.path.islink(src) or filename.startswith(".") or filename in BLOCKED_FILES:
                continue
            shutil.copyfile(src, os.path.join(staging, rel, filename))
    with open(os.path.join(staging, "SKILL.md"), "w", encoding="utf-8") as f:
        f.write(render_skill(name, description, body))
    with open(os.path.join(staging, ".gitignore"), "w", encoding="utf-8") as f:
        f.write("*\n")
    with open(os.path.join(staging, MARKER), "w", encoding="utf-8") as f:
        f.write("Copied from the linked Altimate workspace by the altimate-code plugin. Edits here are replaced.\n")


def same_tree(a, b):
    def listing(root):
        found = {}
        for dirpath, _, filenames in os.walk(root):
            for filename in filenames:
                path = os.path.join(dirpath, filename)
                with open(path, "rb") as f:
                    found[os.path.relpath(path, root)] = f.read()
        return found

    try:
        return listing(a) == listing(b)
    except OSError:
        return False


def sync(project):
    skills = read_snapshot(project)
    if skills is None:
        return False
    target_root = os.path.join(project, SKILLS_DIR)
    changed = False
    wanted = set()
    for source, name, description, body in skills:
        if name in wanted:
            continue
        target = os.path.join(target_root, name)
        if os.path.lexists(target) and not is_ours(target):
            continue
        wanted.add(name)
        os.makedirs(target_root, exist_ok=True)
        staging = tempfile.mkdtemp(prefix=f".{name}.", dir=target_root)
        try:
            build_copy(source, name, description, body, staging)
            if os.path.isdir(target) and same_tree(staging, target):
                continue
            if os.path.isdir(target):
                shutil.rmtree(target)
            os.rename(staging, target)
            changed = True
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    if os.path.isdir(target_root):
        for entry in os.listdir(target_root):
            path = os.path.join(target_root, entry)
            # Staging directories start with "." and never match; another session may be using one.
            if NAME_PATTERN.match(entry) and entry not in wanted and is_ours(path):
                shutil.rmtree(path, ignore_errors=True)
                changed = True
    return changed


def main():
    project = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    try:
        if sync(project):
            print("changed")
    except Exception as err:  # never break session start
        print(f"altimate-code plugin: workspace skill copy failed: {err}", file=sys.stderr)


if __name__ == "__main__":
    main()
