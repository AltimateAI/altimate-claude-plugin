#!/usr/bin/env bash
# SessionStart hook for the altimate-code plugin. Emits a descriptive statement
# of the altimate-code skill's capabilities so Claude can route to it when the
# task shape fits. Deliberately descriptive rather than imperative — see the
# Claude plugin review-criteria checklist items on "avoid instructing Claude
# to call other tools" and "don't interfere with tool sequencing."
#
# Uses printf (not a here-doc) so the hook works in restricted sandboxes that
# refuse to create the temporary file a here-doc needs.

# CLI mode (MCP server unavailable or disallowed) also carries the project routing
# guidance; MCP mode carries only the description.
. "$(dirname "$0")/data-mode.sh"
MODE="$(altimate_data_mode)"

# Both modes: copy the linked Altimate workspace's skills into the project's
# `.claude/skills/` (see sync-workspace-skills.py) so they load as Claude Code
# skills. The copy of what is already on disk runs here, before Claude's first
# reply. A project that was never synced, or not for an hour, is refreshed from
# the workspace by a detached `workspace refresh`: it takes seconds of network
# time, so the hook does not wait for it, a lock keeps one refresh per project
# (a lock older than ten minutes belongs to a refresh that died), and Claude
# Code's skill watcher picks the copies up when it finishes. Projects altimate-code
# has never worked in (no `.altimate-code` directory) are skipped silently.
# Set ALTIMATE_CLAUDE_SKILL_SYNC=0 to turn all of this off.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
SYNC_SCRIPT="$(dirname "$0")/sync-workspace-skills.py"
RELOAD=""
SKILLS_NOTE=""

if [ "${ALTIMATE_CLAUDE_SKILL_SYNC:-1}" != "0" ] && command -v python3 >/dev/null 2>&1; then
  if [ "$(python3 -I "$SYNC_SCRIPT" "$PROJECT_DIR" 2>/dev/null)" = "changed" ]; then
    RELOAD=',
    "reloadSkills": true'
  fi

  if [ -d "$PROJECT_DIR/.altimate-code" ]; then
    SNAPSHOT="$PROJECT_DIR/.altimate-code/skill/_workspace"
    if [ -z "$(find "$SNAPSHOT/.synced-at" -mmin -60 2>/dev/null)" ]; then
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

  # Marked directories are the copies this plugin made; user-written skills do not carry the marker.
  if [ -n "$(find "$PROJECT_DIR/.claude/skills" -mindepth 2 -maxdepth 2 -name .altimate-workspace-skill 2>/dev/null | head -n 1)" ]; then
    SKILLS_NOTE=' The linked Altimate workspace'"'"'s team skills are available in this session as project skills (copied into `.claude/skills/`), next to the workspace conventions, knowledge and memory that the workspace tools return.'
  fi
fi

printf '%s\n' '{'
printf '  "hookSpecificOutput": {\n'
printf '    "hookEventName": "SessionStart",\n'
if [ "$MODE" = "cli" ]; then
  printf '    "additionalContext": "The altimate-code plugin ships two skills in this session. (1) The `altimate-code` skill describes the model-free data tools of altimate-code: column-level lineage, downstream-impact analysis, PII detection, data-diff between tables or databases, FinOps and query cost, query equivalence, dialect translation, dbt manifest and lineage, and read-only queries and schema inspection on connected warehouses. They reach Claude in two ways. When the session has the plugin MCP tools (named `mcp__plugin_altimate-code_altimate-code__*`), those are the tools. When it does not, because the organisation disallows MCP servers or the server did not start, the same tools run from the shell through the altimate CLI `tool run` subcommand, which also returns structured output without a second agent. Neither mode runs a second LLM, and calls are read-only unless the user approves writes. In a project linked to an Altimate workspace, the `workspace_context`, `workspace_skill` and `workspace_execute` tools (MCP, or `tool run` with `--workspace-tools`) give the team conventions, knowledge, shared skills, project memory and read-only queries on the workspace warehouse integrations. Long multi-step jobs such as dbt builds and migrations can be delegated to the altimate-code agent. Plain file edits to dbt models and SQL files need none of this. (2) The `review` skill runs the altimate-code dbt PR reviewer on dbt project changes (models/**.sql, schema.yml, dbt_project.yml, sources.yml, macros, snapshots, seeds). It emits a signed verdict envelope with column lineage, query equivalence, dbt anti-pattern detection, and PII screening, which native tools and a generic code-review skill do not compute. For non-dbt code review (TypeScript, Python, Go), the `review` skill declines. In this session the altimate-code MCP server is not available, so the following project guidance applies. Data work in this project: the warehouses and dbt project of this repository are connected to Altimate Code through its CLI. When a request needs warehouse data or schema, column lineage, downstream impact, PII checks, data diffs or warehouse cost, use the Altimate Code CLI instead of ad-hoc database clients: run `altimate-code tool context` once, then `altimate-code tool run <tool> --workspace-tools --args <json>`; find a tool with `altimate-code tool list --workspace-tools` and its arguments with `altimate-code tool schema <tool> --workspace-tools`. `tool context` also names the linked workspace and lists its team skills. Questions about the team conventions, definitions or workspace data start with `tool run workspace_context --workspace-tools`; warehouse reads through the workspace engine use `tool run workspace_execute --workspace-tools`. It uses the configured connections and is read-only by default. Long multi-step jobs (dbt builds, migrations, backfills) use `altimate-code run`. Code edits, docs, tests and git work that need no warehouse data or lineage use the normal tools.%s"%s\n' "$SKILLS_NOTE" "$RELOAD"
else
  printf '    "additionalContext": "The altimate-code plugin ships two skills in this session. (1) The `altimate-code` skill describes the model-free data tools of altimate-code: column-level lineage, downstream-impact analysis, PII detection, data-diff between tables or databases, FinOps and query cost, query equivalence, dialect translation, dbt manifest and lineage, and read-only queries and schema inspection on connected warehouses. They reach Claude in two ways. When the session has the plugin MCP tools (named `mcp__plugin_altimate-code_altimate-code__*`), those are the tools. When it does not, because the organisation disallows MCP servers or the server did not start, the same tools run from the shell through the altimate CLI `tool run` subcommand, which also returns structured output without a second agent. Neither mode runs a second LLM, and calls are read-only unless the user approves writes. In a project linked to an Altimate workspace, the `workspace_context`, `workspace_skill` and `workspace_execute` tools (MCP, or `tool run` with `--workspace-tools`) give the team conventions, knowledge, shared skills, project memory and read-only queries on the workspace warehouse integrations. Long multi-step jobs such as dbt builds and migrations can be delegated to the altimate-code agent. Plain file edits to dbt models and SQL files need none of this. (2) The `review` skill runs the altimate-code dbt PR reviewer on dbt project changes (models/**.sql, schema.yml, dbt_project.yml, sources.yml, macros, snapshots, seeds). It emits a signed verdict envelope with column lineage, query equivalence, dbt anti-pattern detection, and PII screening, which native tools and a generic code-review skill do not compute. For non-dbt code review (TypeScript, Python, Go), the `review` skill declines.%s"%s\n' "$SKILLS_NOTE" "$RELOAD"
fi
printf '  }\n'
printf '}\n'
