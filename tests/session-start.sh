#!/usr/bin/env bash
# Runs the SessionStart hook against a scratch project that has a synced workspace
# snapshot, in both modes: the output is one valid JSON object, the workspace skills
# are copied into .claude/skills, a user's own skill is untouched, and
# ALTIMATE_CLAUDE_SKILL_SYNC=0 copies nothing.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/plugins/altimate-code/hooks-handlers/session-start.sh"
FAILURES=0
fail() { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }

TMP="$(mktemp -d)" && [ -d "$TMP" ] || { echo "FAIL: could not create a temp dir"; exit 1; }
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/home/.altimate"
printf '{"altimateInstanceName":"acme","altimateUrl":"https://api.example.com","altimateApiKey":"k"}\n' > "$TMP/home/.altimate/altimate.json"

make_project() {
  local dir="$1"
  mkdir -p "$dir/.altimate-code/skill/_workspace/id-1" "$dir/.claude/skills/own"
  printf '{"version":2,"datamateId":1,"tenant":"acme","apiUrl":"https://api.example.com","account":"9ac3583027c136a71b25e6b5e396312c22f12f2acf805e383e3281d91dd8d59a","skills":{"id-1":{}}}\n' > "$dir/.altimate-code/skill/_workspace/.manifest.json"
  date > "$dir/.altimate-code/skill/_workspace/.synced-at"
  printf -- '---\nname: team-style\ndescription: Team style\n---\nUse `stg_` prefixes.\n' > "$dir/.altimate-code/skill/_workspace/id-1/SKILL.md"
  printf 'mine\n' > "$dir/.claude/skills/own/SKILL.md"
}

for mode in mcp cli; do
  project="$TMP/$mode"
  make_project "$project"
  out="$(HOME="$TMP/home" ALTIMATE_DATA_MODE=$mode CLAUDE_PROJECT_DIR="$project" bash "$HOOK" 2>/dev/null)"
  note="$(printf '%s' "$out" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["hookSpecificOutput"]["additionalContext"])' 2>/dev/null)" \
    || { fail "$mode: output is not valid JSON"; continue; }
  [ -f "$project/.claude/skills/team-style/SKILL.md" ] || fail "$mode: workspace skill was not copied"
  [ "$(cat "$project/.claude/skills/own/SKILL.md")" = "mine" ] || fail "$mode: user skill was changed"
  printf '%s' "$note" | grep -q 'available in this session as project skills' || fail "$mode: context does not mention the project skills"
done

project="$TMP/off"
make_project "$project"
out="$(HOME="$TMP/home" ALTIMATE_DATA_MODE=mcp ALTIMATE_CLAUDE_SKILL_SYNC=0 CLAUDE_PROJECT_DIR="$project" bash "$HOOK" 2>/dev/null)"
printf '%s' "$out" | python3 -I -c 'import json,sys; json.load(sys.stdin)' || fail "disabled: output is not valid JSON"
[ ! -e "$project/.claude/skills/team-style" ] || fail "ALTIMATE_CLAUDE_SKILL_SYNC=0 still copied skills"

# Turning it off later removes the copies made earlier, and only those.
project="$TMP/turned-off"
make_project "$project"
HOME="$TMP/home" ALTIMATE_DATA_MODE=mcp CLAUDE_PROJECT_DIR="$project" bash "$HOOK" >/dev/null 2>&1
[ -d "$project/.claude/skills/team-style" ] || fail "turned-off: skill was not copied first"
out="$(HOME="$TMP/home" ALTIMATE_DATA_MODE=mcp ALTIMATE_CLAUDE_SKILL_SYNC=0 CLAUDE_PROJECT_DIR="$project" bash "$HOOK" 2>/dev/null)"
[ ! -e "$project/.claude/skills/team-style" ] || fail "ALTIMATE_CLAUDE_SKILL_SYNC=0 kept the earlier copies"
[ "$(cat "$project/.claude/skills/own/SKILL.md")" = "mine" ] || fail "turned-off: user skill was changed"
printf '%s' "$out" | python3 -I -c 'import json,sys; assert json.load(sys.stdin)["hookSpecificOutput"]["reloadSkills"] is True' \
  || fail "turned-off: removal did not ask Claude Code to reload skills"

[ "$FAILURES" -eq 0 ] && echo "session-start: all checks passed"
exit "$FAILURES"
