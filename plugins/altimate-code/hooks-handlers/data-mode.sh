#!/usr/bin/env bash
# Prints "mcp" or "cli": whether this session can use the plugin's altimate-code
# MCP server. Sourced by session-start.sh; no altimate-code process is started.
#
# cli when any of:
#   - ALTIMATE_DATA_MODE=cli (ALTIMATE_DATA_MODE=mcp forces mcp)
#   - no `altimate-code` executable on PATH, so the server in .mcp.json cannot start
#   - Claude Code settings (managed, user or project) deny the server:
#     deniedMcpServers names it, allowedMcpServers is set without it, or
#     disabledMcpjsonServers lists it
altimate_data_mode() {
  case "${ALTIMATE_DATA_MODE:-}" in
    cli|mcp) printf '%s\n' "$ALTIMATE_DATA_MODE"; return ;;
  esac
  if ! command -v altimate-code >/dev/null 2>&1; then
    printf 'cli\n'; return
  fi
  local project="${CLAUDE_PROJECT_DIR:-$PWD}"
  local files=(
    "/Library/Application Support/ClaudeCode/managed-settings.json"
    "/etc/claude-code/managed-settings.json"
    "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
    "$project/.claude/settings.json"
    "$project/.claude/settings.local.json"
  )
  local existing=() f
  for f in "${files[@]}"; do [ -f "$f" ] && existing+=("$f"); done
  if [ "${#existing[@]}" -gt 0 ] && command -v python3 >/dev/null 2>&1; then
    python3 -I - "${existing[@]}" <<'PY' 2>/dev/null && return
import json, sys
names = {"altimate-code", "plugin:altimate-code:altimate-code"}
def server_names(entries):
    out = set()
    for e in entries if isinstance(entries, list) else []:
        if isinstance(e, str): out.add(e)
        elif isinstance(e, dict) and isinstance(e.get("serverName"), str): out.add(e["serverName"])
    return out
blocked = False
for path in sys.argv[1:]:
    try:
        data = json.load(open(path))
    except Exception:
        continue
    if not isinstance(data, dict):
        continue
    if names & server_names(data.get("deniedMcpServers")) or "*" in server_names(data.get("deniedMcpServers")):
        blocked = True
    if "allowedMcpServers" in data and not names & server_names(data.get("allowedMcpServers")):
        blocked = True
    if names & server_names(data.get("disabledMcpjsonServers")):
        blocked = True
print("cli" if blocked else "mcp")
PY
  fi
  printf 'mcp\n'
}
