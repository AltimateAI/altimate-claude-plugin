# Changelog

All notable changes to this plugin will be documented in this file.

## [1.3.0-experimental] — Unreleased

### Added
- Optional SQL-results mod: `/altimate-data` opens a bounded session-only pane; `/altimate-query <connection> <SQL>` invokes the existing MCP tool without a model request.
- Transparent observation of existing SQL calls, including backend check findings and errors. No added model calls, startup queries, or tool schemas.
- Mod regression tests and a synthetic local workflow/comparison runner. See `docs/data-workspace-experiment.md` for results and limitations.

## [1.2.0-experimental] — Unreleased — direct MCP use requires an altimate-code build with `mcp serve`

### Added
- Stdio MCP registration for `altimate-code mcp serve`, without `--allow-write`.
- Direct data tools: `warehouse_list`, `warehouse_add`, `sql_execute` (`tables` returns schemas and value profiles in the same call), `sql_materialize` and `answer_commit`; `schema_inspect` and `sql_check` with `mcp serve --all-tools`.
- `analyst` agent with the rules for value-profile inspection, SQL analysis, cross-connection scratch joins, and correctness checks. `answer_commit` is optional; the analyst may end with a plain `FINAL ANSWER:` line.

### Changed
- Routing skill and `/altimate-code:altimate` prefer MCP for data questions with Claude Code reasoning. If the MCP tools are unavailable, they fall back to CLI analyst delegation and tell the user which path is used. Released builds without `mcp serve` fail to start the MCP server and use this fallback.
- Long jobs and capabilities outside the five MCP tools retain CLI delegation and agent-persona guidance.
- Delegated runs use `builder` (no `fast-edit` persona) and the canonical-binary resolver from 1.1.x.
- Documentation covers experimental prerequisites, connection discovery, read-only enforcement limits, local result files, and separate reasoning/billing paths.

## [1.1.1] — 2026-10-20

### Fixed
- The skills and slash commands now resolve the CLI as `altimate`, its canonical name since v0.7.1, and fall back to `altimate-code` for npm installs older than v0.7.1. Older curl and PowerShell installs expose only `altimate`, so the plugin reported "not installed" on machines where the CLI was present. Workspace, link and sign-in commands use the same lookup.
- Install guidance and recovery messages name `altimate`, which every install method provides, and list both the npm and the curl install.

## [1.1.0] — 2026-10-19

### Fixed
- Delegated runs no longer hang. Claude Code's shell leaves stdin open and `altimate-code run` reads piped stdin as part of the task, so the run waited forever before it started. Every `altimate-code run` invocation now redirects stdin from `/dev/null`.
- The skill and `/altimate-code:altimate` no longer pass `--agent fast-edit`. altimate-code has no such agent, so every run fell back to `builder` with a warning. Runs now ask for `builder` directly.
- Sign-in advice uses `altimate-code auth login -p altimate-backend --method "Altimate LLM Gateway"`. Without `--method`, `auth login` waits at a menu that Claude Code's `!` prompt cannot answer.
- The output file is created with `mktemp "${TMPDIR:-/tmp}/altimate-result.XXXXXX"`. On macOS, `mktemp -t altimate-result.XXXXXX.md` left the `X`s in the name.

### Added
- Altimate workspaces: the skill, `/altimate-code:altimate` and the SessionStart context say that a linked project's runs use the workspace's skills, knowledge and memory, route questions about the team's own conventions and knowledge to altimate-code, and tell the user how to sign in and link. Linking from Claude Code lists the workspaces with `altimate-code workspace list` (in altimate-code releases that have it) and links the chosen one with `link --workspace`, because the `link` picker needs a terminal that `!` does not provide.
- README: "Use an Altimate workspace" setup, and the install command for Anthropic's plugin directory.

### Changed
- Docs name the command `/altimate-code:altimate`, as Claude Code lists it. Claude Code namespaces plugin commands, so a bare `/altimate` answers "Unknown command".

## [1.0.0] — 2026-07-09

### Added
- Initial release of the `altimate-code` plugin.
- Delegation skill (`skills/altimate-code/SKILL.md`) that routes dbt and warehouse tasks to the [altimate-code](https://github.com/AltimateAI/altimate-code) CLI agent instead of Claude's native tools.
- SessionStart hook (`hooks/hooks.json`) that describes the plugin's capabilities in the system prompt so Claude can route to it when the task shape fits.
- `/altimate` slash command (`commands/altimate.md`) for explicit delegation with agent-persona selection (`fast-edit` / `analyst` / `builder`).
