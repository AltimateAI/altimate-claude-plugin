#!/usr/bin/env bash
# Workspace rules hook for the altimate-code plugin. In a project linked to an
# Altimate workspace, it brings the workspace's team rules into this session and,
# with learning from sessions on, lets corrections made here become proposed
# rules, through `altimate learn hook <event>` (`altimate-code` is the same CLI),
# which applies every gate. Team rules need workspaces on, a sign-in, a link and
# the learning kill switch not off (ALTIMATE_LEARN / learn.enabled). Capturing
# corrections and drafting also need learning from sessions on: your own
# `learn enable` / `learn disable` choice, else the workspace's "Learn from
# sessions" setting.
#   session-start       team rules, proposals waiting for the person and new
#                       reviews, printed as context (one CLI call, a bounded sync)
#   user-prompt-submit  the prompt is recorded if it reads as a correction
#                       (in the background, no model call)
#   stop                the post-turn check, at most one model call per check
#                       round, a few per Stop at most (in the background)
# It never fails the session: every path exits 0 and the CLI's errors are
# dropped. Every event starts the CLI only where altimate-code's workspace link
# cache (in the person's own state directory, never in the repository) names the
# host's directory or a folder above it in the repository. The per-turn events
# never block: they run in the background. Session start waits for the CLI. With
# ALTIMATE_LEARN=0 (or false) nothing is started at all.
#
# The hook input is passed through on stdin; nothing here parses it.

EVENT="${1:-}"
HOST="claude"
INPUT="$(cat)"

# ALTIMATE_LEARN=0 or false turns workspace rules off in the CLI, so there is nothing to start.
case "$(printf '%s' "${ALTIMATE_LEARN:-}" | tr '[:upper:]' '[:lower:]')" in
  0|false) exit 0 ;;
esac

for ALTIMATE_NAME in altimate altimate-code; do
  ALTIMATE_BIN="$(unalias "$ALTIMATE_NAME" 2>/dev/null; unset -f "$ALTIMATE_NAME" 2>/dev/null; command -v "$ALTIMATE_NAME")"
  [ -x "$ALTIMATE_BIN" ] && break || ALTIMATE_BIN=
done
[ -n "$ALTIMATE_BIN" ] || exit 0

# $ROOT bounds the walk up the link cache. The CLI runs in the host's directory (no `cd`), because a workspace link can
# be for a folder inside the repository (a dbt project). Nothing in the repository decides whether the CLI runs: a file
# there can come from a branch or a merge.
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# linked: whether the workspace link cache has a key for the host's directory or a folder above it, up to the
# repository root. This mirrors the CLI, which looks there and never below the directory it runs in. Keys are native
# paths written as JSON strings, so each folder is converted (`cygpath -w` on Windows), JSON-escaped, then escaped for
# the regular expression. It is matched with both quotes and the colon after them: `/x/app` never matches `/x/app-old`,
# and a folder that appears only as a value (a row's `projectPath`) is not a key.
linked() {
  local cache="${XDG_STATE_HOME:-$HOME/.local/state}/altimate-code/altimate-workspace-bindings.json"
  local top dir key
  [ -f "$cache" ] || return 1
  top="$(cd "$ROOT" 2>/dev/null && pwd -P)"
  dir="$(pwd -P)"
  [ -n "$top" ] && [ -n "$dir" ] || return 1
  while :; do
    key="$dir"
    command -v cygpath >/dev/null 2>&1 && key="$(cygpath -w "$dir")"
    key="$(printf '%s' "$key" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/[][\.*^$+?(){}|]/\\&/g')"
    grep -qE "\"$key\"[[:space:]]*:" "$cache" 2>/dev/null && return 0
    case "$dir" in "$top"|/) return 1 ;; esac
    dir="$(dirname "$dir")"
  done
}

case "$EVENT" in
  session-start)
    # Only a directory the link cache names can have team rules: elsewhere the CLI is not started at all.
    linked || exit 0
    OUTPUT="$(printf '%s' "$INPUT" | "$ALTIMATE_BIN" learn hook session-start --host "$HOST" 2>/dev/null)"
    # Only the hook's JSON: an altimate-code without `learn hook` prints its help instead.
    case "$OUTPUT" in
      '{'*) printf '%s\n' "$OUTPUT" ;;
    esac
    ;;
  user-prompt-submit|stop)
    linked || exit 0
    ( printf '%s' "$INPUT" | nohup "$ALTIMATE_BIN" learn hook "$EVENT" --host "$HOST" & ) >/dev/null 2>&1 </dev/null
    ;;
esac
exit 0
