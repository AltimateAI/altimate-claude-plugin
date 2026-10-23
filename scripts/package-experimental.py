#!/usr/bin/env python3
"""Build an offline pilot marketplace from a verified, local CLI build."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--core", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    binary, core, output = args.binary.resolve(), args.core.resolve(), args.output.resolve()
    archive = output.with_suffix(".zip")
    if output.exists():
        parser.error("output must not exist; preserve previous artifacts")
    if archive.exists():
        parser.error("archive already exists; preserve previous artifacts")
    if binary.suffix.lower() == ".exe":
        parser.error("Windows packaging is not implemented; use a verified macOS/Linux build")
    stamp_path = binary.with_name("build-inputs.json")
    stamp = json.loads(stamp_path.read_text())
    inputs = {entry["path"]: entry["sha256"] for entry in stamp["inputs"]}
    for name, expected in inputs.items():
        source = (core / name).resolve()
        if not source.is_relative_to(core) or not source.is_file() or sha(source) != expected:
            parser.error(f"CLI build is stale or its input is outside the checkout: {name}")
    # Mirror stamp-inputs.ts's walk so newly added source files also invalidate a build.
    roots = set(stamp["roots"])
    for pattern in stamp.get("rootGlobs", []):
        roots.update(str(path.relative_to(core)) for path in core.glob(pattern) if path.is_dir())
    for root in roots:
        for current, dirs, files in os.walk(core / root):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in {"node_modules", ".turbo", ".cache", "dist", "target"}]
            for name in files:
                if name.startswith(".") or Path(name).suffix not in {".ts", ".tsx", ".json", ".txt", ".md", ".mp3"}:
                    continue
                relative = str((Path(current) / name).relative_to(core))
                if relative not in inputs:
                    parser.error(f"CLI build predates source input: {relative}")
    env = {**os.environ, "ALTIMATE_CLI_SKIP_UPDATE_CHECK": "1"}
    env.pop("ALTIMATE_CODE_SERVE", None)

    def run(*command):
        return subprocess.check_output([str(binary), *command], env=env, stderr=subprocess.STDOUT, timeout=30).decode()

    if "--workspace-tools" not in run("mcp", "serve", "--help"):
        parser.error("binary does not support the experimental MCP registration")
    help_text = run("workspace-client", "--help")
    for action in ("context", "remember", "engine-install"):
        if action not in help_text:
            parser.error(f"binary does not support workspace-client {action}")
    version = run("--version").strip()
    plugin_repo = Path(__file__).resolve().parents[1]
    plugin_name = "altimate-code-experimental"
    plugin = output / "plugins" / plugin_name
    shutil.copytree(plugin_repo / "plugins" / plugin_name, plugin, ignore=shutil.ignore_patterns("runtime", "tests", "__pycache__"))
    runtime = plugin / "runtime"
    runtime.mkdir()
    shutil.copy2(binary, runtime / "altimate-code")
    shutil.copy2(stamp_path, runtime / "build-inputs.json")
    (output / ".claude-plugin").mkdir()
    (output / ".claude-plugin" / "marketplace.json").write_text(json.dumps({
        "name": "altimate-experimental-pilot", "owner": {"name": "AltimateAI"},
        "plugins": [{"name": plugin_name, "source": f"./plugins/{plugin_name}", "strict": False}],
    }, indent=2) + "\n")
    provenance = {
        "target": stamp["target"], "version": version, "sha256": sha(binary),
        "buildInputsAggregate": stamp["aggregate"],
        "coreCommit": subprocess.check_output(["git", "-C", str(core), "rev-parse", "HEAD"], text=True).strip(),
        "coreHasUncommittedChanges": bool(subprocess.check_output(["git", "-C", str(core), "status", "--porcelain"])),
        "pluginCommit": subprocess.check_output(["git", "-C", str(plugin_repo), "rev-parse", "HEAD"], text=True).strip(),
        "pluginHasUncommittedChanges": bool(subprocess.check_output(["git", "-C", str(plugin_repo), "status", "--porcelain"])),
    }
    (output / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted(output.rglob("*")):
            if path.is_file():
                bundle.write(path, str(Path(output.name) / path.relative_to(output)))
    print(json.dumps({"marketplace": str(output), "archive": str(archive), **provenance}, indent=2))


if __name__ == "__main__":
    main()
