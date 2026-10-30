#!/usr/bin/env bash
# Workspace rules hook for the altimate-code plugin. In a project linked to an
# Altimate workspace with learning on, it brings the workspace's team rules into
# this session and lets corrections made here become proposed rules, through
# `altimate-code learn hook <event>` (which applies every gate: learning and
# workspaces on, signed in, linked).
#   session-start       team rules, proposals waiting for the person and new
#                       reviews, printed as context (one CLI call, a bounded sync)
#   user-prompt-submit  the prompt is recorded if it reads as a correction
#                       (in the background, no model call)
#   stop                the post-turn check, at most one model call
#                       (in the background)
# It never fails or blocks the session: every path exits 0 and the CLI's errors
# are dropped. The per-turn events run only where workspace rules state exists
# (session start is what creates it), so other projects pay nothing.
#
# The hook input is passed through on stdin; nothing here parses it.

EVENT="${1:-}"
HOST="claude"
INPUT="$(cat)"

for ALTIMATE_NAME in altimate altimate-code; do
  ALTIMATE_BIN="$(unalias "$ALTIMATE_NAME" 2>/dev/null; unset -f "$ALTIMATE_NAME" 2>/dev/null; command -v "$ALTIMATE_NAME")"
  [ -x "$ALTIMATE_BIN" ] && break || ALTIMATE_BIN=
done
[ -n "$ALTIMATE_BIN" ] || exit 0

# Run from the host's directory, not the repository root: a workspace link can be for a folder inside the repository
# (a dbt project), and the CLI finds the root itself.
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
STATE="$ROOT/.altimate-code/learn/workspace-rules/rules.json"

case "$EVENT" in
  session-start)
    # Only a repository with workspace rules state, or one the workspace link cache names (the repository or a folder
    # inside it), can have team rules: elsewhere the CLI is not started at all.
    if [ ! -f "$STATE" ]; then
      CACHE="${XDG_STATE_HOME:-$HOME/.local/state}/altimate-code/altimate-workspace-bindings.json"
      REAL="$(cd "$ROOT" 2>/dev/null && pwd -P)"
      [ -n "$REAL" ] && grep -qF "\"$REAL" "$CACHE" 2>/dev/null || exit 0
    fi
    OUTPUT="$(printf '%s' "$INPUT" | "$ALTIMATE_BIN" learn hook session-start --host "$HOST" 2>/dev/null)"
    # Only the hook's JSON: an altimate-code without `learn hook` prints its help instead.
    case "$OUTPUT" in
      '{'*) printf '%s\n' "$OUTPUT" ;;
    esac
    ;;
  user-prompt-submit|stop)
    [ -f "$STATE" ] || exit 0
    ( printf '%s' "$INPUT" | nohup "$ALTIMATE_BIN" learn hook "$EVENT" --host "$HOST" & ) >/dev/null 2>&1 </dev/null
    ;;
esac
exit 0
