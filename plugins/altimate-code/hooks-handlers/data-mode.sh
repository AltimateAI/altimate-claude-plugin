#!/usr/bin/env bash
# Prints "mcp" or "cli": whether this session can use the plugin's altimate-code
# MCP server. Sourced by session-start.sh; no altimate-code process is started.
#
# cli when any of:
#   - ALTIMATE_DATA_MODE=cli (ALTIMATE_DATA_MODE=mcp forces mcp)
#   - no `altimate-code` executable on PATH, so the server in .mcp.json cannot start
#   - a managed-mcp.json is present: it takes exclusive control of MCP servers
#   - Claude Code settings deny the server, as Claude Code applies them to a plugin
#     server, by its scoped name plugin:altimate-code:altimate-code or its command:
#     deniedMcpServers (merged from every source) names it;
#     allowedMcpServers (merged, or managed only with allowManagedMcpServersOnly)
#     exists and admits neither (a stdio server needs a serverCommand match when
#     the list has serverCommand entries); or it was turned off in /mcp for this
#     project (disabledMcpServers in .claude.json)
# Managed settings from an MDM profile or the Windows registry are not read.
altimate_data_mode() {
  case "${ALTIMATE_DATA_MODE:-}" in
    cli|mcp) printf '%s\n' "$ALTIMATE_DATA_MODE"; return ;;
  esac
  if ! command -v altimate-code >/dev/null 2>&1; then
    printf 'cli\n'; return
  fi
  local project="${CLAUDE_PROJECT_DIR:-$PWD}"
  local config="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  local args=() dir f
  for dir in "/Library/Application Support/ClaudeCode" "/etc/claude-code"; do
    [ -f "$dir/managed-mcp.json" ] && { printf 'cli\n'; return; }
    for f in "$dir/managed-settings.json" "$dir"/managed-settings.d/*.json; do
      [ -f "$f" ] && args+=("managed:$f")
    done
  done
  for f in "$config/settings.json" "$project/.claude/settings.json" "$project/.claude/settings.local.json"; do
    [ -f "$f" ] && args+=("other:$f")
  done
  # Claude Code keeps per-project state in .claude.json (in CLAUDE_CONFIG_DIR when set, else in
  # HOME), keyed by the project's git root, which for a worktree is the main repository.
  f="${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"
  if [ -f "$f" ]; then
    args+=("state:$f")
    local root common
    root="$(git -C "$project" rev-parse --show-toplevel 2>/dev/null)" && args+=("key:$root")
    common="$(git -C "$project" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" && args+=("key:${common%/.git}")
  fi
  if [ "${#args[@]}" -gt 0 ] && command -v python3 >/dev/null 2>&1; then
    # -c, not a here-doc: session-start.sh must work in sandboxes that refuse
    # the temporary file a here-doc needs.
    python3 -I -c '
import json, sys
names = {"plugin:altimate-code:altimate-code"}
command = ["altimate-code", "mcp", "serve", "--workspace-tools"]
def load(path):
    try:
        data = json.load(open(path))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}
def entries(value):
    out = []
    for e in value if isinstance(value, list) else []:
        if isinstance(e, str): out.append({"serverName": e})
        elif isinstance(e, dict): out.append(e)
    return out
managed, other, state = [], [], {}
keys = {sys.argv[1]}
for arg in sys.argv[2:]:
    kind, _, path = arg.partition(":")
    if kind == "managed": managed.append(load(path))
    elif kind == "other": other.append(load(path))
    elif kind == "state": state = load(path)
    elif kind == "key": keys.add(path)
blocked = False
if any(e.get("serverName") in names or e.get("serverCommand") == command
       for s in managed + other for e in entries(s.get("deniedMcpServers"))):
    blocked = True
only_managed = any(s.get("allowManagedMcpServersOnly") is True for s in managed)
lists = [s["allowedMcpServers"] for s in (managed if only_managed else managed + other) if "allowedMcpServers" in s]
if lists:
    allowed = [e for value in lists for e in entries(value)]
    commands = [e for e in allowed if "serverCommand" in e]
    if commands:
        blocked = blocked or not any(e["serverCommand"] == command for e in commands)
    else:
        blocked = blocked or not any(e.get("serverName") in names for e in allowed)
projects = state.get("projects") if isinstance(state.get("projects"), dict) else {}
for key in keys:
    toggles = projects.get(key)
    if isinstance(toggles, dict) and names & {e.get("serverName") for e in entries(toggles.get("disabledMcpServers"))}:
        blocked = True
print("cli" if blocked else "mcp")
' "$project" "${args[@]}" 2>/dev/null && return
  fi
  printf 'mcp\n'
}
