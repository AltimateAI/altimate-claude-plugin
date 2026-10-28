#!/usr/bin/env bash
# SessionStart hook for the altimate-code plugin. Emits a descriptive statement
# of the altimate-code skill's capabilities so Claude can route to it when the
# task shape fits. Deliberately descriptive rather than imperative — see the
# Claude plugin review-criteria checklist items on "avoid instructing Claude
# to call other tools" and "don't interfere with tool sequencing."
#
# Uses printf (not a here-doc) so the hook works in restricted sandboxes that
# refuse to create the temporary file a here-doc needs.
#
# It also copies the linked Altimate workspace's skills into the project's
# `.claude/skills/` (see sync-workspace-skills.py). The copy of what is already
# on disk runs here, before Claude's first reply; refreshing that from the
# workspace takes seconds of network time, so it runs in the background and
# Claude Code's skill watcher picks up the result. Set
# ALTIMATE_CLAUDE_SKILL_SYNC=0 to turn both off.

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
SYNC_SCRIPT="$(dirname "$0")/sync-workspace-skills.py"
RELOAD=""

if [ "${ALTIMATE_CLAUDE_SKILL_SYNC:-1}" != "0" ] && command -v python3 >/dev/null 2>&1; then
  if [ "$(python3 -I "$SYNC_SCRIPT" "$PROJECT_DIR" 2>/dev/null)" = "changed" ]; then
    RELOAD=',
    "reloadSkills": true'
  fi

  # Only projects altimate-code has worked in can be linked to a workspace.
  if [ -d "$PROJECT_DIR/.altimate-code" ]; then
    # Claude Code watches only skill directories that exist when it starts, so
    # create it now for copies the background refresh adds.
    if [ ! -d "$PROJECT_DIR/.claude/skills" ] && mkdir -p "$PROJECT_DIR/.claude/skills" 2>/dev/null; then
      RELOAD=',
    "reloadSkills": true'
    fi
    for ALTIMATE_NAME in altimate altimate-code; do
      ALTIMATE_BIN="$(unalias "$ALTIMATE_NAME" 2>/dev/null; unset -f "$ALTIMATE_NAME" 2>/dev/null; command -v "$ALTIMATE_NAME")"
      [ -x "$ALTIMATE_BIN" ] && break || ALTIMATE_BIN=
    done
    LOCK="$PROJECT_DIR/.altimate-code/claude-skill-sync.lock"
    # A lock older than ten minutes belongs to a refresh that died.
    find "$LOCK" -maxdepth 0 -mmin +10 -exec rmdir {} \; 2>/dev/null
    if [ -n "$ALTIMATE_BIN" ] && mkdir "$LOCK" 2>/dev/null; then
      (
        "$ALTIMATE_BIN" workspace refresh --directory "$PROJECT_DIR"
        python3 -I "$SYNC_SCRIPT" "$PROJECT_DIR"
        rmdir "$LOCK"
      ) </dev/null >/dev/null 2>&1 &
    fi
  fi
fi

printf '%s\n' '{'
printf '  "hookSpecificOutput": {\n'
printf '    "hookEventName": "SessionStart",\n'
printf '    "additionalContext": "The altimate-code plugin ships two skills in this session. (1) The `altimate-code` skill routes data-engineering work to the altimate-code CLI — column-level lineage, downstream-impact, cross-database validation, FinOps, PII from sampled rows, query cost attribution, schema diffs, dev-vs-prod diffing. In a project linked to an Altimate workspace it also answers from the shared skills, knowledge and memory of that workspace, so questions about team conventions, standards or best practices fit it too. It also lists, refreshes and publishes the workspace skills, so sharing a project skill with the team goes through it. It is not well-suited for pure file/code edits to dbt models and SQL files that do not touch warehouse state — native Bash/Edit/Write handles those faster. (2) The `review` skill runs the altimate-code dbt PR reviewer on dbt project changes (models/**.sql, schema.yml, dbt_project.yml, sources.yml, macros, snapshots, seeds). It emits a signed verdict envelope with column lineage, query equivalence, dbt anti-pattern detection, and PII screening — none of which native tools or a generic code-review skill can compute. When the user asks to review dbt / SQL / warehouse changes, this is the specialized reviewer available. For non-dbt code review (TypeScript, Python, Go), the `review` skill declines."%s\n' "$RELOAD"
printf '  }\n'
printf '}\n'
