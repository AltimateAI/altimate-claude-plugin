# Changelog

All notable changes to this plugin will be documented in this file.

## [1.1.0-experimental] — Unreleased — experimental; requires an altimate-code build with `mcp serve`

### Added
- Stdio MCP registration for `altimate-code mcp serve`, without `--allow-write`.
- Direct data tools: `warehouse_list`, `schema_inspect`, `sql_execute`, `sql_check`, and `sql_materialize`.
- Lean `data-question` skill for value-profile inspection, SQL analysis, cross-connection scratch joins, and correctness checks.

### Changed
- Routing skill, `/altimate`, and SessionStart context use MCP directly for data questions with Claude Code reasoning; long jobs retain CLI delegation and agent-persona guidance.
- Documentation covers experimental prerequisites, connection discovery, read-only enforcement limits, local result files, and separate reasoning/billing paths.

## [1.0.0] — 2026-07-09

### Added
- Initial release of the `altimate-code` plugin.
- Delegation skill (`skills/altimate-code/SKILL.md`) that routes dbt and warehouse tasks to the [altimate-code](https://github.com/AltimateAI/altimate-code) CLI agent instead of Claude's native tools.
- SessionStart hook (`hooks/hooks.json`) that describes the plugin's capabilities in the system prompt so Claude can route to it when the task shape fits.
- `/altimate` slash command (`commands/altimate.md`) for explicit delegation with agent-persona selection (`fast-edit` / `analyst` / `builder`).
