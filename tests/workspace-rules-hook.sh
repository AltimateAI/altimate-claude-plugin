#!/usr/bin/env bash
# Checks the workspace-rules hook against a stub CLI: it passes the hook input through, prints only the CLI's hook
# JSON at session start, runs the per-turn events in the background and only where workspace rules state exists,
# and never fails or blocks the session.
set -u
cd "$(dirname "$0")/.."
HOOK="$(find "$PWD/plugins/altimate-code" -name '*workspace-rules.sh' | head -n1)"
[ -f "$HOOK" ] || { echo "FAIL: no workspace-rules hook script"; exit 1; }
grep -q "$(basename "$HOOK")" plugins/altimate-code/hooks/hooks.json || { echo "FAIL: hooks.json does not run $(basename "$HOOK")"; exit 1; }
HOST="$(sed -n 's/^HOST="\(.*\)"$/\1/p' "$HOOK")"
FAILURES=0
fail() { echo "FAIL: $*"; FAILURES=$((FAILURES + 1)); }

WORK="$(mktemp -d)" && [ -d "$WORK" ] || { echo "FAIL: could not create a temp dir"; exit 1; }
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
LOG="$WORK/calls"
mkdir -p "$BIN" "$WORK/project" "$WORK/bare"
git -C "$WORK/project" init -q
# The stub records its arguments and stdin; STUB_MODE picks how it answers.
cat > "$BIN/altimate-code" <<STUB
#!/bin/sh
INPUT="\$(cat)"
printf '%s|%s\n' "\$*" "\$INPUT" >> "$LOG"
case "\${STUB_MODE:-ok}" in
  ok) [ "\$3" = "session-start" ] && printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"rules"}}\n' ;;
  help) echo "altimate-code learn: unknown command" ;;
  fail) echo "boom" >&2; exit 1 ;;
  slow) sleep 4 ;;
esac
exit 0
STUB
chmod +x "$BIN/altimate-code"

# hook <dir> <event> <PATH> [STUB_MODE] → prints "exit|stdout"
hook() {
  local out rc
  out="$(cd "$1" && printf '{"session_id":"s1","prompt":"no, that is wrong"}' | env PATH="$3" STUB_MODE="${4:-ok}" XDG_STATE_HOME="$WORK/xdg" bash "$HOOK" "$2" 2>&1)"
  rc=$?
  printf '%s|%s' "$rc" "$out"
}
SYS="/usr/bin:/bin"
# Wait for a background call to land in the log (at most 5s).
await_log() { for _ in $(seq 50); do grep -q "$1" "$LOG" 2>/dev/null && return 0; sleep 0.1; done; return 1; }

: > "$LOG"
# Neither workspace rules state nor a workspace link: the CLI is not started at session start.
[ "$(hook "$WORK/project" session-start "$BIN:$SYS")" = "0|" ] || fail "session start printed output in a project with no link"
[ ! -s "$LOG" ] || fail "session start ran the CLI in a project with no link: $(cat "$LOG")"
# A link for a folder inside the repository (a dbt project), started from the repository root: the CLI runs.
mkdir -p "$WORK/xdg/altimate-code" "$WORK/project/dbt"
printf '{"bindings":{"%s/dbt":{"datamateId":1}}}' "$(cd "$WORK/project" && pwd -P)" > "$WORK/xdg/altimate-code/altimate-workspace-bindings.json"
[ "$(hook "$WORK/project" session-start "$BIN:$SYS")" = '0|{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"rules"}}' ] \
  || fail "session start does not print the CLI's hook JSON"
grep -qx "learn hook session-start --host $HOST|{\"session_id\":\"s1\",\"prompt\":\"no, that is wrong\"}" "$LOG" \
  || fail "session start does not pass the hook input and host through: $(cat "$LOG")"

[ "$(hook "$WORK/project" session-start "$BIN:$SYS" help)" = "0|" ] || fail "a CLI without \`learn hook\` leaks its output"
[ "$(hook "$WORK/project" session-start "$BIN:$SYS" fail)" = "0|" ] || fail "a failing CLI fails the hook or leaks its error"
[ "$(hook "$WORK/project" session-start "$SYS")" = "0|" ] || fail "a missing CLI fails the hook"

: > "$LOG"
for event in user-prompt-submit stop; do
  [ "$(hook "$WORK/project" "$event" "$BIN:$SYS")" = "0|" ] || fail "$event without rules state did not exit quietly"
done
sleep 0.5
[ ! -s "$LOG" ] || fail "per-turn events ran the CLI without workspace rules state: $(cat "$LOG")"

mkdir -p "$WORK/project/.altimate-code/learn/workspace-rules"
echo '{}' > "$WORK/project/.altimate-code/learn/workspace-rules/rules.json"
mkdir -p "$WORK/project/models"
for event in user-prompt-submit stop; do
  start=$(date +%s)
  [ "$(hook "$WORK/project/models" "$event" "$BIN:$SYS" slow)" = "0|" ] || fail "$event did not exit quietly"
  [ $(( $(date +%s) - start )) -lt 3 ] || fail "$event waited for the CLI instead of running it in the background"
  await_log "learn hook $event --host $HOST|{\"session_id\":\"s1\"" || fail "$event did not run the CLI with the hook input"
done

[ "$(hook "$WORK/bare" user-prompt-submit "$BIN:$SYS")" = "0|" ] || fail "outside a git repository the hook failed"

[ "$FAILURES" -eq 0 ] && echo "ok" || { echo "$FAILURES failure(s)"; exit 1; }
