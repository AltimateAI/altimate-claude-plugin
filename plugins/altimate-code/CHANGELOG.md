# Changelog

All notable changes to this plugin will be documented in this file.

## [1.4.0] — 2026-10-28

### Added
- Team workspace skills as Claude Code skills, in both the MCP and CLI modes. At session start `hooks-handlers/sync-workspace-skills.py` copies the skills of the Altimate workspace linked to the project (from `.altimate-code/skill/_workspace/`) into `.claude/skills/`. Copies keep only `name` and `description` from the frontmatter, have `!` command blocks disarmed, leave out files Claude Code reads as hooks, agents, commands or settings, are served only for the Altimate tenant the user is signed in to, never replace a skill the user wrote (copies carry a marker file; a name clash skips the workspace skill), and get a `.gitignore` so they stay out of version control. When the workspace drops a skill, its copy is removed. The SessionStart context mentions the project skills when copies exist.
- A project that was never synced, or not for an hour, is refreshed by a detached `altimate workspace refresh` that the hook does not wait for. It is bounded by a per-project lock that expires after ten minutes, and it is skipped silently when no CLI is on PATH or the project has no `.altimate-code` directory. Claude Code's skill watcher loads the copies when it finishes.
- `ALTIMATE_CLAUDE_SKILL_SYNC=0` turns the skill copy and refresh off.
- Tests: `tests/test_sync_workspace_skills.py` (`python3 -m pytest tests/`).
- `hooks-handlers/refresh-skills.sh` holds the refresh: `--if-stale` starts it in the background only when the snapshot is missing or over an hour old, `--wait` refreshes now and reports how many skills were copied. SessionStart never waits on the network.
- A Stop hook runs the same hourly background refresh in long sessions, so updated or removed workspace skills reach the session.
- `/altimate-code:refresh-skills` refreshes the workspace skills on demand.
- Tests: `tests/refresh-skills.sh`.

### Fixed
- Workspace skill copying runs under a per-project lock, reads the snapshot only once it holds it, and swaps each copy with rollback, so concurrent sessions and background refreshes cannot remove each other's copies.
- A snapshot that exists but cannot be read leaves the copies as they are; a symlinked `SKILL.md`, a symlinked snapshot or a manifest without a tenant is not served.
- A failed background refresh is retried at most hourly instead of after every turn; `--wait` no longer removes the lock of a refresh that is still running.
- The SessionStart mode check no longer uses a here-doc, so MCP deny settings are honoured in sandboxes that refuse its temporary file.
- The warehouse guard allows only a lone altimate command; chained commands are checked.
- The `analyst` agent no longer reads `.env` files or adds connections.

### Changed
- The skill, the `analyst` agent and the CLI-mode SessionStart text describe the three workspace features in both modes: team skills as project skills, conventions, knowledge and memory through `workspace_context`, and warehouse reads through `workspace_execute`. With a CLI that turns workspace tools on in linked projects, `tool context` also prints the workspace name and its team skills; the plugin still passes `--workspace-tools` so older CLIs work.

## [1.3.0] — 2026-10-28

### Added
- MCP registration (`.mcp.json`): the `altimate-code` stdio server runs `altimate-code mcp serve`, read-only by default. Tools: `warehouse_list`, `warehouse_add`, `sql_execute` (`tables` returns schemas and value profiles in the same call), `sql_materialize`, `answer_commit`, plus `impact_analysis`, `dbt_lineage`, `altimate_core_column_lineage`, `schema_detect_pii`, `data_diff`, `altimate_core_equivalence` and `sql_translate`. It needs an altimate-code build that contains `mcp serve`, and the CLI on PATH as `altimate-code`; curl installs expose only `altimate`, so they need an `altimate-code` link for the server to start (the CLI mode works either way).
- The skill, `/altimate-code:altimate`, the `analyst` agent and the SessionStart text describe two modes. When tools named `mcp__plugin_altimate-code_altimate-code__*` are available, they are used. When they are not (an organisation's managed settings disallow MCP servers, the server failed to start, or the build lacks `mcp serve`), the same tools run through `altimate tool run`, starting with one `tool context` call that prints the connections, schema listing and analyst method. An organisation that blocks MCP therefore still gets every tool.

- SessionStart picks the mode without starting the CLI (`hooks-handlers/data-mode.sh`). It uses the CLI mode when `altimate-code` is not on PATH, when managed, user or project settings deny the server (`deniedMcpServers`, an `allowedMcpServers` list without it, or `disabledMcpjsonServers`), or when `ALTIMATE_DATA_MODE=cli`; `ALTIMATE_DATA_MODE=mcp` forces the MCP mode. Only the CLI mode adds the project routing guidance (the same text `altimate-code link --claude-md` writes to `CLAUDE.md`); the MCP mode adds none.
- Tests: `tests/data-mode.sh`.
- Linked Altimate workspaces in both modes, without an altimate-code agent. The MCP server starts with `--workspace-tools`, and in CLI mode every `tool run`, `tool list` and `tool schema` call passes `--workspace-tools` (one warm tool process per project). Claude uses `workspace_context` (setup status, receipt, summary, skills, memory and, with `include_tools`, the operation catalog), `workspace_skill` and `workspace_execute` (`ask_knowledge_base`, workspace warehouse connections and read-only queries). The skill covers setup statuses (`needs_auth`, `needs_workspace`, `disabled`, `unavailable`, `needs_engine`), receipt refresh, engine installation only after the user agrees, linking with `ALTIMATE_DISABLE_MEMORY=1`, skill list/refresh/publish, and memory saving only on explicit request through `workspace-client remember`. Older CLIs without `--workspace-tools` keep delegating workspace questions to `run`.
- Tests: `tests/workspace-tools.sh` (static checks; with `ALTIMATE_TEST_BIN`, a live check against a CLI build).

### Changed
- The `analyst` agent works in both modes and ends with `FINAL ANSWER:`, optionally recorded with `answer_commit`.
- `/altimate-code:altimate` answers data questions with the MCP tools when present and otherwise delegates with the `analyst` agent; long jobs use `builder`.

## [1.2.0] — 2026-10-27

### Changed
- The `altimate-code` skill now has Claude call the model-free data tools itself with `altimate tool run <name> --args '<json>'` instead of delegating each task to a second agent. It lists which tools fit which question, how to pass arguments, that calls are read-only until the user approves `--allow-write`, and to ask a clarifying question when a request has two readings. Delegation with `altimate run` stays for long multi-step jobs and is the fallback when the CLI has no `tool` subcommand.
- The skill description and SessionStart context describe the tools directly and no longer claim work Claude does well alone.

### Added
- Opt-in PreToolUse hook `warehouse-guard.sh`, active only when `ALTIMATE_ROUTE_GUARD=1`. It denies Bash commands that query a warehouse directly and suggests the matching `tool run`. `altimate` commands, dbt and file operations pass.
- `analyst` agent: a read-only data analyst that works through `tool run`.
- Tests: `tests/warehouse-guard.sh`.

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
