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

case "$EVENT" in
  session-start)
    OUTPUT="$(printf '%s' "$INPUT" | "$ALTIMATE_BIN" learn hook session-start --host "$HOST" 2>/dev/null)"
    # Only the hook's JSON: an altimate-code without `learn hook` prints its help instead.
    case "$OUTPUT" in
      '{'*) printf '%s\n' "$OUTPUT" ;;
    esac
    ;;
  user-prompt-submit|stop)
    ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
    [ -f "$ROOT/.altimate-code/learn/workspace-rules/rules.json" ] || exit 0
    ( printf '%s' "$INPUT" | nohup "$ALTIMATE_BIN" learn hook "$EVENT" --host "$HOST" & ) >/dev/null 2>&1 </dev/null
    ;;
esac
exit 0
