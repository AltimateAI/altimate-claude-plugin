#!/usr/bin/env bash
# Exercises refresh-skills.sh and its hook wiring with a fake `altimate` CLI that
# writes a workspace snapshot: SessionStart returns before a slow refresh ends and
# the copy lands afterwards, a fresh snapshot is not refreshed, the Stop hook and
# the manual command are wired, and --wait refreshes and reports the copies.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="$ROOT/plugins/altimate-code"
REFRESH="$PLUGIN/hooks-handlers/refresh-skills.sh"
FAILURES=0
fail() { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }

TMP="$(mktemp -d)" && [ -d "$TMP" ] || { echo "FAIL: could not create a temp dir"; exit 1; }
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/home/.altimate" "$TMP/bin"
printf '{"altimateInstanceName":"acme","altimateUrl":"https://api.example.com"}\n' > "$TMP/home/.altimate/altimate.json"
# Fake CLI: `workspace refresh --directory D` sleeps FAKE_DELAY, logs the call and writes a snapshot.
cat > "$TMP/bin/altimate" <<'FAKE'
#!/usr/bin/env bash
[ "$1 $2" = "workspace refresh" ] || exit 2
dir="$4"; snap="$dir/.altimate-code/skill/_workspace"
sleep "${FAKE_DELAY:-0}"
echo refresh >> "$dir/refresh.log"
[ -z "${FAKE_FAIL:-}" ] || exit 1
mkdir -p "$snap/id-1"
printf '{"tenant":"acme","apiUrl":"https://api.example.com","skills":{"id-1":{}}}\n' > "$snap/.manifest.json"
printf -- '---\nname: team-style\ndescription: Team style\n---\nUse `stg_` prefixes.\n' > "$snap/id-1/SKILL.md"
date > "$snap/.synced-at"
FAKE
chmod +x "$TMP/bin/altimate"
export HOME="$TMP/home" PATH="$TMP/bin:$PATH"

wait_for() { for _ in $(seq 1 50); do [ -e "$1" ] && return 0; sleep 0.1; done; return 1; }

# Never synced: SessionStart returns at once, the slow refresh copies the skill later.
p="$TMP/first"; mkdir -p "$p/.altimate-code"
start=$(date +%s)
out="$(FAKE_DELAY=2 CLAUDE_PROJECT_DIR="$p" bash "$PLUGIN/hooks-handlers/session-start.sh" 2>/dev/null)"
[ $(( $(date +%s) - start )) -lt 2 ] || fail "SessionStart waited for the refresh"
printf '%s' "$out" | python3 -I -c 'import json,sys; assert json.load(sys.stdin)["hookSpecificOutput"]["reloadSkills"] is True' \
  || fail "SessionStart did not ask Claude Code to watch the new skills directory"
[ ! -e "$p/.claude/skills/team-style" ] || fail "skill copied before the refresh finished"
wait_for "$p/.claude/skills/team-style/SKILL.md" || fail "background refresh did not copy the skill"
wait_for "$p/.claude/skills/team-style/.altimate-workspace-skill" || fail "copy is not marked as a workspace skill"

# Fresh snapshot: no refresh.
p="$TMP/fresh"; mkdir -p "$p/.altimate-code"
CLAUDE_PROJECT_DIR="$p" bash "$TMP/bin/altimate" workspace refresh --directory "$p"; rm "$p/refresh.log"
CLAUDE_PROJECT_DIR="$p" bash "$REFRESH" --if-stale; sleep 0.5
[ ! -e "$p/refresh.log" ] || fail "fresh snapshot was refreshed"

# Hour-old snapshot: refreshed.
touch -t "$(date -v-2H +%Y%m%d%H%M 2>/dev/null || date -d '-2 hour' +%Y%m%d%H%M)" "$p/.altimate-code/skill/_workspace/.synced-at"
CLAUDE_PROJECT_DIR="$p" bash "$REFRESH" --if-stale
wait_for "$p/refresh.log" || fail "stale snapshot was not refreshed"

# One refresh at a time per project.
p="$TMP/lock"; mkdir -p "$p/.altimate-code"
FAKE_DELAY=1 CLAUDE_PROJECT_DIR="$p" bash "$REFRESH" --if-stale
FAKE_DELAY=1 CLAUDE_PROJECT_DIR="$p" bash "$REFRESH" --if-stale
sleep 2; wait_for "$p/refresh.log"; sleep 0.3
[ "$(wc -l < "$p/refresh.log" | tr -d ' ')" = "1" ] || fail "two refreshes ran at once"

# A refresh that fails (never writes .synced-at) is not retried at the next Stop.
p="$TMP/failing"; mkdir -p "$p/.altimate-code"
FAKE_FAIL=1 CLAUDE_PROJECT_DIR="$p" bash "$REFRESH" --if-stale
wait_for "$p/refresh.log"; sleep 0.3
FAKE_FAIL=1 CLAUDE_PROJECT_DIR="$p" bash "$REFRESH" --if-stale; sleep 0.5
[ "$(wc -l < "$p/refresh.log" | tr -d ' ')" = "1" ] || fail "failed refresh was retried within the hour"

# Manual refresh waits and reports.
p="$TMP/manual"; mkdir -p "$p/.altimate-code"
msg="$(CLAUDE_PROJECT_DIR="$p" bash "$REFRESH" --wait)" || fail "--wait exited non-zero"
printf '%s' "$msg" | grep -q 'Workspace skills in .claude/skills: 1\.' || fail "--wait output: $msg"
[ -f "$p/.claude/skills/team-style/SKILL.md" ] || fail "--wait did not copy the skill"

# Not linked and opted out: nothing happens.
p="$TMP/unlinked"; mkdir -p "$p"
CLAUDE_PROJECT_DIR="$p" bash "$REFRESH" --wait | grep -q 'not linked' || fail "unlinked project not reported"
p="$TMP/off"; mkdir -p "$p/.altimate-code"
ALTIMATE_CLAUDE_SKILL_SYNC=0 CLAUDE_PROJECT_DIR="$p" bash "$REFRESH" --if-stale; sleep 0.5
[ ! -e "$p/refresh.log" ] || fail "ALTIMATE_CLAUDE_SKILL_SYNC=0 still refreshed"

# Wiring.
python3 -I - "$PLUGIN/hooks/hooks.json" <<'PY' || fail "Stop hook is not wired to refresh-skills.sh --if-stale"
import json, sys
stop = json.load(open(sys.argv[1]))["hooks"]["Stop"]
assert any("refresh-skills.sh\" --if-stale" in h["command"] for e in stop for h in e["hooks"])
PY
grep -q 'refresh-skills.sh" --wait' "$PLUGIN/commands/refresh-skills.md" || fail "manual command does not run --wait"

[ "$FAILURES" -eq 0 ] && echo "refresh-skills: all checks passed"
exit "$FAILURES"
