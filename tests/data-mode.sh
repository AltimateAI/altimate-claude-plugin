#!/usr/bin/env bash
# Checks the SessionStart mode choice: MCP when the plugin's server can start and
# is allowed, CLI (with routing guidance) otherwise.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/plugins/altimate-code/hooks-handlers/session-start.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/with/bin" "$TMP/without/bin" "$TMP/config" "$TMP/project/.claude"
printf '#!/bin/sh\nexit 0\n' > "$TMP/with/bin/altimate-code"; chmod +x "$TMP/with/bin/altimate-code"
FAILURES=0

# expect <name> <PATH dir> <user settings json or ""> <project settings json or ""> <env> <expected mode>
expect() {
  rm -f "$TMP/config/settings.json" "$TMP/project/.claude/settings.json"
  [ -n "$3" ] && printf '%s' "$3" > "$TMP/config/settings.json"
  [ -n "$4" ] && printf '%s' "$4" > "$TMP/project/.claude/settings.json"
  local out mode
  out="$(env -i HOME="$TMP" PATH="$2:/usr/bin:/bin" CLAUDE_CONFIG_DIR="$TMP/config" CLAUDE_PROJECT_DIR="$TMP/project" $5 bash "$HOOK")"
  if ! printf '%s' "$out" | python3 -I -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
    echo "FAIL: $1: output is not JSON"; FAILURES=$((FAILURES + 1)); return
  fi
  if printf '%s' "$out" | grep -q 'altimate-code tool context'; then mode=cli; else mode=mcp; fi
  [ "$mode" = "$6" ] || { echo "FAIL: $1: expected $6, got $mode"; FAILURES=$((FAILURES + 1)); }
}

W="$TMP/with/bin"; N="$TMP/without/bin"
expect "server can start, no settings" "$W" "" "" "" mcp
expect "no altimate-code on PATH" "$N" "" "" "" cli
expect "user denylist names the server" "$W" '{"deniedMcpServers":[{"serverName":"altimate-code"}]}' "" "" cli
expect "allowlist without the server" "$W" '{"allowedMcpServers":[{"serverName":"github"}]}' "" "" cli
expect "allowlist with the server" "$W" '{"allowedMcpServers":[{"serverName":"altimate-code"}]}' "" "" mcp
expect "project disables the server" "$W" "" '{"disabledMcpjsonServers":["altimate-code"]}' "" cli
expect "unrelated denylist" "$W" '{"deniedMcpServers":[{"serverName":"github"}]}' "" "" mcp
expect "malformed settings are ignored" "$W" '{not json' "" "" mcp
expect "env forces cli" "$W" "" "" "ALTIMATE_DATA_MODE=cli" cli
expect "env forces mcp" "$N" "" "" "ALTIMATE_DATA_MODE=mcp" mcp

# session-start.sh and the files it sources must not need a here-doc's temporary file.
! grep -n '<<' "$HOOK" "$ROOT/plugins/altimate-code/hooks-handlers/data-mode.sh" || { echo "FAIL: here-doc in the SessionStart path"; FAILURES=$((FAILURES + 1)); }

[ "$FAILURES" -eq 0 ] && echo "PASS" || { echo "$FAILURES failure(s)"; exit 1; }
