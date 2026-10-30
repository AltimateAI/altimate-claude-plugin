#!/usr/bin/env bash
# Checks that the plugin exposes the linked-workspace tools in both modes: the MCP
# server starts with --workspace-tools, and every documented `tool run|list|schema`
# call passes it (never `tool context`, which rejects it).
#
# With ALTIMATE_TEST_BIN pointing at an altimate-code build that has the `tool`
# CLI, it also runs the real CLI in a scratch project: the workspace tools are
# listed and `workspace_context` answers with a known setup status.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="$ROOT/plugins/altimate-code"
FAILURES=0
fail() { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }

python3 -I - "$PLUGIN/.mcp.json" <<'PY' || fail ".mcp.json does not start mcp serve with --workspace-tools"
import json, sys
args = json.load(open(sys.argv[1]))["mcpServers"]["altimate-code"]["args"]
sys.exit(0 if args[:2] == ["mcp", "serve"] and "--workspace-tools" in args else 1)
PY

for file in skills/altimate-code/SKILL.md agents/analyst.md hooks-handlers/session-start.sh hooks-handlers/warehouse-guard.sh commands/altimate.md; do
  bad="$(grep -noE 'tool (run|list|schema) [^`|]*' "$PLUGIN/$file" | grep -v -- '--workspace-tools' | grep -vE 'tool run <name>`|tool run`|tool (run|list|schema)( \(|\.|,|$| subcommand| path| above| that| tool| with)')"
  [ -z "$bad" ] || fail "$file: tool call without --workspace-tools: $bad"
  grep -nE 'tool context[^`]*--workspace-tools' "$PLUGIN/$file" >/dev/null && fail "$file: tool context must not get --workspace-tools"
done

for tool in workspace_context workspace_skill workspace_execute; do
  grep -q "$tool" "$PLUGIN/skills/altimate-code/SKILL.md" || fail "SKILL.md does not describe $tool"
done

out="$(env -i HOME="$(mktemp -d)" PATH="/usr/bin:/bin" ALTIMATE_DATA_MODE=cli bash "$PLUGIN/hooks-handlers/session-start.sh")"
printf '%s' "$out" | python3 -I -c '
import json, sys
text = json.load(sys.stdin)["hookSpecificOutput"]["additionalContext"]
sys.exit(0 if "tool run workspace_context --workspace-tools" in text else 1)' || fail "CLI-mode SessionStart text does not route workspace questions"

if [ -n "${ALTIMATE_TEST_BIN:-}" ]; then
  SCRATCH="$(mktemp -d)"; trap 'rm -rf "$SCRATCH"' EXIT
  listed="$(cd "$SCRATCH" && ALTIMATE_TOOL_DAEMON=0 "$ALTIMATE_TEST_BIN" tool list --workspace-tools < /dev/null 2>/dev/null)"
  for tool in workspace_context workspace_skill workspace_execute; do
    printf '%s\n' "$listed" | grep -q "^$tool " || fail "live: tool list --workspace-tools does not list $tool"
  done
  status="$(cd "$SCRATCH" && ALTIMATE_TOOL_DAEMON=0 "$ALTIMATE_TEST_BIN" tool run workspace_context --workspace-tools --json < /dev/null 2>/dev/null \
    | python3 -I -c 'import json,sys; print(json.loads(json.load(sys.stdin)["output"])["status"])' 2>/dev/null)"
  case "$status" in
    ready|needs_auth|needs_workspace|disabled|unavailable) ;;
    *) fail "live: workspace_context returned no known status (got '$status')" ;;
  esac
  echo "live: workspace_context status in a scratch project: $status"
fi

[ "$FAILURES" -eq 0 ] && echo "workspace-tools: all checks passed" || { echo "workspace-tools: $FAILURES failure(s)"; exit 1; }
