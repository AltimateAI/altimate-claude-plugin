#!/usr/bin/env bash
# Refreshes the linked Altimate workspace's skills from the workspace, then copies
# them into the project's `.claude/skills/` (see sync-workspace-skills.py). Claude
# Code watches that directory, so copies added mid-session load without a restart.
#
#   refresh-skills.sh --if-stale   background refresh, unless in STALE_MINUTES this
#                                  account refreshed the snapshot or tried to (hooks),
#                                  so a project that cannot refresh retries hourly and
#                                  a newly signed-in account refreshes at once
#   refresh-skills.sh --wait       refresh now and print the outcome (manual refresh)
#
# A lock keeps one refresh per project; a lock older than ten minutes belongs to a
# refresh that died. Projects altimate-code has never worked in (no
# `.altimate-code` directory) are skipped. ALTIMATE_CLAUDE_SKILL_SYNC=0 turns it off.
STALE_MINUTES=60
MODE="${1:---if-stale}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
SYNC_SCRIPT="$(dirname "$0")/sync-workspace-skills.py"
LOCK="$PROJECT_DIR/.altimate-code/claude-skill-sync.lock"

say() { [ "$MODE" = "--wait" ] && printf '%s\n' "$1"; }

if [ "${ALTIMATE_CLAUDE_SKILL_SYNC:-1}" = "0" ]; then say "Workspace skill sync is off (ALTIMATE_CLAUDE_SKILL_SYNC=0)."; exit 0; fi
command -v python3 >/dev/null 2>&1 || { say "python3 is needed to copy workspace skills."; exit 0; }
[ -d "$PROJECT_DIR/.altimate-code" ] || { say "This project is not linked to an Altimate workspace."; exit 0; }

# Per project and account, outside the project so it never shows up in a repository that tracks `.altimate-code/`.
ACCOUNT="$(python3 -I "$SYNC_SCRIPT" --account 2>/dev/null)"
ATTEMPTED="${XDG_CACHE_HOME:-$HOME/.cache}/altimate-code-plugin/skill-refresh-$(printf '%s|%s' "$PROJECT_DIR" "$ACCOUNT" | cksum | cut -d' ' -f1).attempted"
fresh() { [ -n "$(find "$1" -mmin -"$STALE_MINUTES" 2>/dev/null)" ]; }
if [ "$MODE" = "--if-stale" ]; then
  fresh "$ATTEMPTED" && exit 0
  # A recent sync counts only when its snapshot belongs to the signed-in account.
  fresh "$PROJECT_DIR/.altimate-code/skill/_workspace/.synced-at" && python3 -I "$SYNC_SCRIPT" --owned "$PROJECT_DIR" && exit 0
fi

for ALTIMATE_NAME in altimate altimate-code; do
  ALTIMATE_BIN="$(unalias "$ALTIMATE_NAME" 2>/dev/null; unset -f "$ALTIMATE_NAME" 2>/dev/null; command -v "$ALTIMATE_NAME")"
  [ -x "$ALTIMATE_BIN" ] && break || ALTIMATE_BIN=
done
[ -n "$ALTIMATE_BIN" ] || { say "altimate-code CLI not found (tried altimate, altimate-code)."; exit 0; }

# Claude Code watches only skill directories that exist when it starts.
[ -L "$PROJECT_DIR/.claude" ] || mkdir -p "$PROJECT_DIR/.claude/skills" 2>/dev/null

find "$LOCK" -maxdepth 0 -mmin +10 -exec rmdir {} \; 2>/dev/null
if [ "$MODE" = "--wait" ]; then
  # A refresh already in flight finishes first; this one then picks up anything newer.
  LOCKED=
  for _ in $(seq 1 120); do mkdir "$LOCK" 2>/dev/null && LOCKED=1 && break; sleep 1; done
  [ -n "$LOCKED" ] || { say "Another workspace skill refresh is still running; try again when it finishes."; exit 1; }
  "$ALTIMATE_BIN" workspace refresh --directory "$PROJECT_DIR" </dev/null
  STATUS=$?
  python3 -I "$SYNC_SCRIPT" "$PROJECT_DIR" >/dev/null
  rmdir "$LOCK" 2>/dev/null
  COUNT="$(find "$PROJECT_DIR/.claude/skills" -mindepth 2 -maxdepth 2 -name .altimate-workspace-skill 2>/dev/null | wc -l | tr -d ' ')"
  say "Workspace skills in .claude/skills: $COUNT."
  exit "$STATUS"
fi

if mkdir "$LOCK" 2>/dev/null; then
  mkdir -p "$(dirname "$ATTEMPTED")" 2>/dev/null && touch "$ATTEMPTED" 2>/dev/null
  (
    "$ALTIMATE_BIN" workspace refresh --directory "$PROJECT_DIR"
    python3 -I "$SYNC_SCRIPT" "$PROJECT_DIR"
    rmdir "$LOCK"
  ) </dev/null >/dev/null 2>&1 &
fi
exit 0
