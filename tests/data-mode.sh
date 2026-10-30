#!/usr/bin/env bash
# Checks the SessionStart mode choice: MCP when the plugin's server can start and
# is allowed, CLI (with routing guidance) otherwise.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/plugins/altimate-code/hooks-handlers/session-start.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/with/bin" "$TMP/without/bin" "$TMP/curl/bin" "$TMP/config" "$TMP/project/.claude"
printf '#!/bin/sh\nexit 0\n' > "$TMP/with/bin/altimate-code"; chmod +x "$TMP/with/bin/altimate-code"
printf '#!/bin/sh\nexit 0\n' > "$TMP/curl/bin/altimate"; chmod +x "$TMP/curl/bin/altimate"
FAILURES=0

# expect <name> <PATH dir> <user settings json or ""> <project settings json or ""> <env> <expected mode> [.claude.json]
expect() {
  rm -f "$TMP/config/settings.json" "$TMP/project/.claude/settings.json" "$TMP/config/.claude.json"
  [ -n "$3" ] && printf '%s' "$3" > "$TMP/config/settings.json"
  [ -n "$4" ] && printf '%s' "$4" > "$TMP/project/.claude/settings.json"
  [ -n "${7:-}" ] && printf '%s' "$7" > "$TMP/config/.claude.json"
  local out mode
  out="$(env -i HOME="$TMP" PATH="$2:/usr/bin:/bin" CLAUDE_CONFIG_DIR="$TMP/config" CLAUDE_PROJECT_DIR="$TMP/project" $5 bash "$HOOK")"
  if ! printf '%s' "$out" | python3 -I -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
    echo "FAIL: $1: output is not JSON"; FAILURES=$((FAILURES + 1)); return
  fi
  if printf '%s' "$out" | grep -q 'tool context` once'; then mode=cli; else mode=mcp; fi
  [ "$mode" = "$6" ] || { echo "FAIL: $1: expected $6, got $mode"; FAILURES=$((FAILURES + 1)); }
}

W="$TMP/with/bin"; N="$TMP/without/bin"
expect "server can start, no settings" "$W" "" "" "" mcp
expect "no altimate-code on PATH" "$N" "" "" "" cli
expect "user denylist names the plugin server" "$W" '{"deniedMcpServers":[{"serverName":"plugin:altimate-code:altimate-code"}]}' "" "" cli
expect "bare name does not match the plugin server" "$W" '{"deniedMcpServers":[{"serverName":"altimate-code"}]}' "" "" mcp
expect "allowlist without the server" "$W" '{"allowedMcpServers":[{"serverName":"github"}]}' "" "" cli
expect "allowlist with the plugin server" "$W" '{"allowedMcpServers":[{"serverName":"plugin:altimate-code:altimate-code"}]}' "" "" mcp
expect "allowlist with only the bare name" "$W" '{"allowedMcpServers":[{"serverName":"altimate-code"}]}' "" "" cli
expect "disabledMcpjsonServers covers project .mcp.json servers only" "$W" "" '{"disabledMcpjsonServers":["altimate-code"]}' "" mcp
expect "turned off in /mcp for this project" "$W" "" "" "" cli '{"projects":{"'"$TMP/project"'":{"disabledMcpServers":["plugin:altimate-code:altimate-code"]}}}'
expect "turned off in /mcp for another project" "$W" "" "" "" mcp '{"projects":{"/elsewhere":{"disabledMcpServers":["plugin:altimate-code:altimate-code"]}}}'
expect "denylist names the command" "$W" '{"deniedMcpServers":[{"serverCommand":["altimate-code","mcp","serve","--workspace-tools"]}]}' "" "" cli
expect "wildcard name is not expanded" "$W" '{"deniedMcpServers":[{"serverName":"*"}]}' "" "" mcp
expect "allowlist with the exact command" "$W" '{"allowedMcpServers":[{"serverCommand":["altimate-code","mcp","serve","--workspace-tools"]}]}' "" "" mcp
expect "name allowed but command entries exclude it" "$W" '{"allowedMcpServers":[{"serverName":"plugin:altimate-code:altimate-code"},{"serverCommand":["npx","other"]}]}' "" "" cli
expect "allowlists merge across scopes" "$W" '{"allowedMcpServers":[{"serverName":"github"}]}' '{"allowedMcpServers":[{"serverName":"plugin:altimate-code:altimate-code"}]}' "" mcp
expect "empty allowlist blocks" "$W" '{"allowedMcpServers":[]}' "" "" cli
expect "unrelated denylist" "$W" '{"deniedMcpServers":[{"serverName":"github"}]}' "" "" mcp
expect "malformed settings are ignored" "$W" '{not json' "" "" mcp
expect "env forces cli" "$W" "" "" "ALTIMATE_DATA_MODE=cli" cli
expect "env forces mcp" "$N" "" "" "ALTIMATE_DATA_MODE=mcp" mcp

# With CLAUDE_CONFIG_DIR set, a .claude.json in HOME is not Claude Code's.
printf '%s' '{"projects":{"'"$TMP/project"'":{"disabledMcpServers":["plugin:altimate-code:altimate-code"]}}}' > "$TMP/.claude.json"
expect "stale .claude.json in HOME is ignored" "$W" "" "" "" mcp
rm -f "$TMP/.claude.json"

# /mcp toggles are keyed by the git root, so a session in a subfolder of the repository sees them.
mkdir -p "$TMP/repo/sub/.claude" && git -C "$TMP/repo" init -q 2>/dev/null
printf '%s' '{"projects":{"'"$(cd "$TMP/repo" && pwd -P)"'":{"disabledMcpServers":["plugin:altimate-code:altimate-code"]}}}' > "$TMP/config/.claude.json"
out="$(env -i HOME="$TMP" PATH="$W:/usr/bin:/bin" CLAUDE_CONFIG_DIR="$TMP/config" CLAUDE_PROJECT_DIR="$TMP/repo/sub" bash "$HOOK")"
printf '%s' "$out" | grep -q 'tool context` once' || { echo "FAIL: /mcp toggle on the git root not seen from a subfolder"; FAILURES=$((FAILURES + 1)); }
rm -f "$TMP/config/.claude.json"

# CLI mode names the executable that exists: curl installs expose only `altimate`.
out="$(env -i HOME="$TMP" PATH="$TMP/curl/bin:/usr/bin:/bin" CLAUDE_CONFIG_DIR="$TMP/config" CLAUDE_PROJECT_DIR="$TMP/project" bash "$HOOK")"
printf '%s' "$out" | grep -q 'run `altimate tool context` once' || { echo "FAIL: CLI mode does not name altimate when only it is on PATH"; FAILURES=$((FAILURES + 1)); }
printf '%s' "$out" | grep -q '`altimate-code tool' && { echo "FAIL: CLI mode names altimate-code, which is not on PATH"; FAILURES=$((FAILURES + 1)); }

# session-start.sh and the files it sources must not need a here-doc's temporary file.
! grep -n '<<' "$HOOK" "$ROOT/plugins/altimate-code/hooks-handlers/data-mode.sh" || { echo "FAIL: here-doc in the SessionStart path"; FAILURES=$((FAILURES + 1)); }

[ "$FAILURES" -eq 0 ] && echo "PASS" || { echo "$FAILURES failure(s)"; exit 1; }
