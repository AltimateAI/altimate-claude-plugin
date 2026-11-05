#!/usr/bin/env bash
# Checks the workspace-rules hook against a stub CLI: hooks.json runs it for the right events, arguments and timeouts;
# it passes the hook input through, prints only the CLI's hook JSON at session start, starts the CLI for any event only
# where the link cache names the directory or a folder above it in the repository (never because of a file in the
# repository), runs the per-turn events in the background, starts nothing with ALTIMATE_LEARN=0, and never fails or
# blocks the session.
set -u
cd "$(dirname "$0")/.."
PLUGIN="$PWD/plugins/altimate-code"
HOOK="$(find "$PLUGIN" -name '*workspace-rules.sh' | head -n1)"
[ -f "$HOOK" ] || { echo "FAIL: no workspace-rules hook script"; exit 1; }
command -v python3 >/dev/null || { echo "FAIL: python3 is needed to check hooks.json"; exit 1; }
HOST="$(sed -n 's/^HOST="\(.*\)"$/\1/p' "$HOOK")"
FAILURES=0
fail() { echo "FAIL: $*"; FAILURES=$((FAILURES + 1)); }

# hooks.json: each event runs the script with its argument and timeout.
HOOKS_ERRORS="$(python3 - "$PLUGIN/hooks/hooks.json" "${HOOK#"$PLUGIN"/}" <<'PY'
import json, sys
path, script = sys.argv[1], sys.argv[2]
with open(path) as f:
    hooks = json.load(f)["hooks"]
expected = {"SessionStart": ("session-start", 15), "UserPromptSubmit": ("user-prompt-submit", 5), "Stop": ("stop", 5)}
for event, (arg, timeout) in expected.items():
    found = [h for group in hooks.get(event, []) for h in group.get("hooks", [])
             if h.get("type") == "command" and h.get("command", "").startswith("bash ")
             and h.get("command", "").endswith('/%s" %s' % (script, arg))]
    if len(found) != 1:
        print("%s does not run %s %s exactly once" % (event, script, arg))
    elif found[0].get("timeout") != timeout:
        print("%s runs %s %s with timeout %r, expected %d" % (event, script, arg, found[0].get("timeout"), timeout))
PY
)" || fail "could not parse hooks.json"
[ -z "$HOOKS_ERRORS" ] || fail "hooks.json: $HOOKS_ERRORS"

WORK="$(mktemp -d)" && [ -d "$WORK" ] || { echo "FAIL: could not create a temp dir"; exit 1; }
WORK="$(cd "$WORK" && pwd -P)"
PIDS="$WORK/pids"
# Stop the slow stub's background calls before their directories are removed.
trap '[ -f "$PIDS" ] && kill $(cat "$PIDS") 2>/dev/null; rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
LOG="$WORK/calls"
STARTED="$WORK/started"
CACHE="$WORK/xdg/altimate-code/altimate-workspace-bindings.json"
mkdir -p "$BIN" "$WORK/project/dbt/models" "$WORK/project/models" "$WORK/project-old" "$WORK/bare" "$WORK/xdg/altimate-code"
git -C "$WORK/project" init -q
# The stub notes that it started before anything else, then records its arguments and stdin; STUB_MODE picks how it
# answers.
cat > "$BIN/altimate-code" <<STUB
#!/bin/sh
printf '%s\n' "\$*" >> "$STARTED"
INPUT="\$(cat)"
printf '%s|%s\n' "\$*" "\$INPUT" >> "$LOG"
case "\${STUB_MODE:-ok}" in
  ok) [ "\$3" = "session-start" ] && printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"rules"}}\n' ;;
  help) echo "altimate-code learn: unknown command" ;;
  fail) echo "boom" >&2; exit 1 ;;
  slow) echo \$\$ >> "$PIDS"; exec sleep 4 ;;
esac
exit 0
STUB
chmod +x "$BIN/altimate-code"

# hook <dir> <event> <PATH> [STUB_MODE] [VAR=value ...] → prints "exit|stdout"
hook() {
  local dir="$1" event="$2" path="$3" mode="${4:-ok}" out rc
  shift 3; [ $# -gt 0 ] && shift
  out="$(cd "$dir" && printf '{"session_id":"s1","prompt":"no, that is wrong"}' \
    | env -u ALTIMATE_LEARN PATH="$path" STUB_MODE="$mode" XDG_STATE_HOME="$WORK/xdg" "$@" bash "$HOOK" "$event" 2>&1)"
  rc=$?
  printf '%s|%s' "$rc" "$out"
}
# link <dir>...: the link cache holds exactly these folders (written as the CLI writes them: JSON strings).
link() {
  python3 -c 'import json, sys; print(json.dumps({"bindings": {d: {"datamateId": 1} for d in sys.argv[1:]}}))' "$@" > "$CACHE"
}
SYS="/usr/bin:/bin"
JSON='0|{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"rules"}}'
# Wait for a background call to land in the log (at most 5s).
await_log() { for _ in $(seq 50); do grep -q "$1" "$LOG" 2>/dev/null && return 0; sleep 0.1; done; return 1; }
# Session start runs the CLI in the foreground, so whether it started is known once the hook returns.
started() { [ -s "$STARTED" ]; }
reset() { : > "$LOG"; : > "$STARTED"; }

reset
# No workspace link: the CLI is not started at session start.
[ "$(hook "$WORK/project" session-start "$BIN:$SYS")" = "0|" ] || fail "session start printed output in a project with no link"
! started || fail "session start ran the CLI in a project with no link: $(cat "$LOG")"
# A workspace rules state file in the repository (a branch or a merge can bring one) does not make it linked.
mkdir -p "$WORK/project/.altimate-code/learn/workspace-rules"
echo '{"version":1,"scope":{"datamateId":1}}' > "$WORK/project/.altimate-code/learn/workspace-rules/rules.json"
reset
[ "$(hook "$WORK/project" session-start "$BIN:$SYS")" = "0|" ] || fail "a rules state file in the repository printed output"
! started || fail "a rules state file in the repository ran the CLI at session start"

# A link for a folder inside the repository (a dbt project), started below it: the CLI runs.
link "$WORK/project/dbt"
[ "$(hook "$WORK/project/dbt/models" session-start "$BIN:$SYS")" = "$JSON" ] \
  || fail "session start does not print the CLI's hook JSON below a linked folder"
grep -qx "learn hook session-start --host $HOST|{\"session_id\":\"s1\",\"prompt\":\"no, that is wrong\"}" "$LOG" \
  || fail "session start does not pass the hook input and host through: $(cat "$LOG")"
reset
[ "$(hook "$WORK/project/dbt" session-start "$BIN:$SYS")" = "$JSON" ] || fail "session start in the linked folder did not run the CLI"
# The same link, started at the repository root: the CLI would not find it, so it is not started.
reset
[ "$(hook "$WORK/project" session-start "$BIN:$SYS")" = "0|" ] || fail "session start at the root printed output with only a child folder linked"
! started || fail "session start at the repository root ran the CLI with only a child folder linked"
# A link for the repository, started in a subfolder: the CLI runs.
link "$WORK/project"
reset
[ "$(hook "$WORK/project/dbt/models" session-start "$BIN:$SYS")" = "$JSON" ] || fail "session start below a linked repository did not run the CLI"
# A link for a sibling folder sharing the repository's name as a prefix: not a link for this repository.
link "$WORK/project-old" "$WORK/projectX/dbt"
reset
[ "$(hook "$WORK/project" session-start "$BIN:$SYS")" = "0|" ] || fail "a sibling-prefix link printed output"
! started || fail "session start ran the CLI for a link to $WORK/project-old"
# Folder names with a quote or a backslash are matched as their JSON-escaped keys.
ODD="$WORK/odd\"name\\repo"
mkdir -p "$ODD/sub" && git -C "$ODD" init -q
link "$ODD"
reset
[ "$(hook "$ODD/sub" session-start "$BIN:$SYS")" = "$JSON" ] || fail "a linked folder whose name has a quote or backslash was not found"
# On Windows (Git Bash, MSYS, Cygwin) the CLI keys the cache by native paths; a stub `cygpath -w` stands in for it.
mkdir -p "$WORK/winbin"
printf '#!/bin/sh\nprintf "C:%%s" "$2" | tr / "\\\\\\\\"\n' > "$WORK/winbin/cygpath"
chmod +x "$WORK/winbin/cygpath"
link "C:$(printf '%s' "$WORK/project/dbt" | tr / '\\')"
reset
[ "$(hook "$WORK/project/dbt/models" session-start "$WORK/winbin:$BIN:$SYS")" = "$JSON" ] \
  || fail "a link keyed by a native Windows path was not found: $(cat "$CACHE")"
reset
[ "$(hook "$WORK/project" session-start "$WORK/winbin:$BIN:$SYS")" = "0|" ] && ! started \
  || fail "session start at the repository root ran the CLI with only a child folder linked (Windows paths)"

link "$WORK/project"
[ "$(hook "$WORK/project" session-start "$BIN:$SYS" help)" = "0|" ] || fail "a CLI without \`learn hook\` leaks its output"
[ "$(hook "$WORK/project" session-start "$BIN:$SYS" fail)" = "0|" ] || fail "a failing CLI fails the hook or leaks its error"
[ "$(hook "$WORK/project" session-start "$SYS")" = "0|" ] || fail "a missing CLI fails the hook"
# ALTIMATE_LEARN=0 (or false, any case) turns everything off: the CLI is not started.
for off in 0 false FALSE; do
  reset
  [ "$(hook "$WORK/project" session-start "$BIN:$SYS" ok ALTIMATE_LEARN="$off")" = "0|" ] \
    || fail "session start with ALTIMATE_LEARN=$off printed output"
  ! started || fail "session start with ALTIMATE_LEARN=$off ran the CLI"
done

# Per-turn events with no link (the repository's planted rules state file still there), and with ALTIMATE_LEARN=0 where
# the repository is linked, start nothing. They would run the CLI in the background, so a positive call made afterwards
# has to land first (proving background calls get through) and the log is then watched for a bounded time.
link
reset
for event in user-prompt-submit stop; do
  [ "$(hook "$WORK/project" "$event" "$BIN:$SYS")" = "0|" ] || fail "$event without a link did not exit quietly"
done
link "$WORK/project"
for event in user-prompt-submit stop; do
  [ "$(hook "$WORK/project" "$event" "$BIN:$SYS" ok ALTIMATE_LEARN=0)" = "0|" ] || fail "$event with ALTIMATE_LEARN=0 did not exit quietly"
done
[ "$(hook "$WORK/project" stop "$BIN:$SYS")" = "0|" ] || fail "stop in a linked repository did not exit quietly"
await_log "learn hook stop --host $HOST" || fail "stop in a linked repository did not run the CLI"
for _ in $(seq 20); do [ "$(grep -c . "$STARTED")" -gt 1 ] && break; sleep 0.1; done
[ "$(cat "$STARTED")" = "learn hook stop --host $HOST" ] \
  || fail "per-turn events ran the CLI without a link or with ALTIMATE_LEARN=0: $(cat "$STARTED")"

reset
for event in user-prompt-submit stop; do
  start=$(date +%s)
  [ "$(hook "$WORK/project/models" "$event" "$BIN:$SYS" slow)" = "0|" ] || fail "$event did not exit quietly"
  [ $(( $(date +%s) - start )) -lt 3 ] || fail "$event waited for the CLI instead of running it in the background"
  await_log "learn hook $event --host $HOST|{\"session_id\":\"s1\"" || fail "$event did not run the CLI with the hook input"
done

[ "$(hook "$WORK/bare" user-prompt-submit "$BIN:$SYS")" = "0|" ] || fail "outside a git repository the hook failed"

[ "$FAILURES" -eq 0 ] && echo "ok" || { echo "$FAILURES failure(s)"; exit 1; }
