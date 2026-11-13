# Changelog

All notable changes to this plugin will be documented in this file.

## [1.6.0] — 2026-11-13

### Added
- dbt helpers from dbt Power User, in the Claude Code session. Each runs the project's own dbt (its `.venv/bin/dbt` when there is one) and calls no model:
  - **Compile and validate.** After Claude edits or writes a model, the plugin runs it with `dbt show` (one row) against the warehouse. dbt's error, or the columns `schema.yml` documents that the query no longer returns and those it returns undocumented, go to Claude with the edit's result and to a line above the prompt; the **dbt check** pane shows every column, or dbt's whole error. The check says when the columns could not be compared, and runs again when the model or its schema file changes outside Claude's edits.
  - **Explain and Fix.** A failed `dbt run`, `test`, `build`, `seed` or `snapshot` puts the failed nodes, read from `run_results.json`, above the prompt with **Explain** and **Fix with Altimate Code** (`/altimate-code:altimate`).
  - **Results pane.** Rows from Claude's `dbt show`, `/dbt-show <model>` and `/dbt-show select …` open as a table beside the chat, with **Re-run** (same target, profile, vars and limit), **Bookmark**, **Clear history** and a history kept across sessions on this machine.
  - **Model context.** When Claude reads a model, its materialization, columns (types, descriptions, tests), parents, children and depth upstream and downstream, from `target/manifest.json`, go with the file, once a turn.
  - **Environment doctor.** At session start the plugin checks dbt, Python, the profile's adapter, installed packages and whether the manifest is older than the project's files, and offers **Run dbt parse** (or **Run dbt deps**). `/dbt-doctor` runs the checks with the warehouse connection test.
- The `dbt_mods` option turns the dbt helpers off.

## [1.5.0] — 2026-11-10

### Added
- Team rules from a linked Altimate workspace apply in Claude Code sessions. At session start the plugin gives Claude the workspace's approved rules for the repository, the number of proposed rules waiting for you, and the owner's reviews of your proposals since your last session.
- Corrections you make to Claude are recorded locally (UserPromptSubmit, no model call). After a turn, altimate-code checks them in the background (Stop) and keeps a proposed rule when you corrected the same topic in two sessions or corrected a team rule Claude was given.
- "Remember this as a team rule: …" said to Claude waits as a proposal (no model call).
- `/altimate-code:rules`: answer proposed rules (send for review, approve as owner, edit, save as memory, or "Not a rule"), and see the team rules and the review status of your proposals.
- The hooks run altimate-code only where the session's folder (or a folder above it in the repository) is in altimate-code's workspace link cache, which is in your own state directory: nothing in the repository turns them on. Team rules arrive in a linked project when you are signed in; recording corrections and drafting proposals also need learning on. `ALTIMATE_LEARN=0` turns all of it off and the hooks start nothing.
- Start the session in the linked folder or below it: with only a subfolder linked (a dbt project), a session started at the repository root gets no team rules.
- The hooks need an altimate-code release with `learn hook`; with an older one they do nothing.

## [1.4.2] — 2026-11-09

### Fixed
- Lineage counts read right. "No model for certain (2 may)" replaces "at least 0 models", a dashboard that only may read a column is called a maybe, and one dashboard is "1 dashboard".
- `/lineage` replies with what it found, so a model that doesn't exist says so. It also says where the pane is: beside the chat when docked, above the prompt otherwise.
- In a terminal under 144 columns, Claude Code holds back a pane the plugin opens on its own. A toast now says so once, and that `/lineage` opens it.
- The pane says when the shown model's `.sql` changed after the manifest was written, by an edit or a shell command, until `dbt compile` and `r`. The edit note and toast say it too.
- A graph too big for Claude Code to draw in a pane is shown as folders, with a line saying why. Before, the pane was blank or cut off.
- An edit's column check uses the edited model's own columns: the pane's, an earlier read's, or `dbt_lineage` through the CLI. A column that `schema.yml` leaves out is traced, whatever model the pane shows.
- Claude Code hands over a column reach of about 49 KB or more as a preview of a saved file. That file is now read, so a widely read column keeps its column detail.
- Work the plugin schedules no longer fails a session that has ended, such as after a reload or `/clear`.

## [1.4.1] — 2026-11-06

### Added
- Lineage beside the chat (`hooks/lineage.tsx`, a Claude Code mod): a pane follows the dbt model Claude reads or edits and draws its upstream and downstream models, dashboards and column lineage from `target/manifest.json`, with no model calls. `/lineage <model>[.column]` opens it on a model. A column the engine can't classify shows no derivation label, rather than "Not sure" on every column. See the README's "Lineage beside the chat".
- Impact first: before an edit to a model's SQL lands, the plugin checks what reads the model and the columns the edit touches. It adds the result to Claude's context and leaves a band above the prompt with the severity and counts.

### Fixed
- A manifest over 4 MiB is read through altimate-code. When the answer arrives cut off, the pane now reports that the answer could not be read, and asking again tries again. An edit that hits this goes ahead with a toast saying the lookup failed, and Claude is told that what reads the model is unknown. Before, the pane said "No dbt model matches" for a model that exists and kept saying so until the manifest changed, and the edit got no note and no message. altimate-code releases up to 0.12.9 can cut off a large answer on a pipe.

### Upgrading
- A 1.4.0 install from this marketplace made before lineage merged has no lineage, and `plugin update` calls it current, because it compares versions. In a terminal, run `claude plugin marketplace update altimate-claude-plugin`, then `claude plugin update altimate-code@altimate-claude-plugin`, then restart Claude Code.

## [1.4.0] — 2026-10-28

### Added
- One-click integrations (`hooks/integrations.tsx`, a Claude Code mod; typed by `types/index.d.ts`): a band offers Connect, Keep local, Review or Later for GitHub, Jira and Linear credentials found on the machine, `/integrations` opens a side pane to add, update, sync, allow sync, disconnect or link a workspace, and the status line counts connected integrations. It runs `altimate integrations`, trying `altimate` then `altimate-code` only when the first is not installed.
- Signed out of Altimate, the band and pane offer Sign in to sync and hide the sync buttons; everything stays local.
- Keep local is durable: sync, Sync all and Link workspace skip it until Allow sync. In a provider's Update form it removes the workspace connection this tool made and keeps the credential on this machine, with the token pasted again. Connect or Keep local on a found credential acts on what was found, not on values left in an earlier form, and shows the CLI's notes.
- A credential is tested with its provider before it is uploaded, by Connect and by Sync alike, and a known token expiry is saved with the workspace connection. A credential the workspace marks invalid is not kept (a new connection is removed again), and local secrets are deleted only after the workspace accepts the upload.
- Sync all and Link workspace upload nothing over a connection this tool already saved to the workspace; they only attach it to the linked workspace, also when this machine has no record of it, and say so when it was deleted there. A credential found here stays offered next to a connection made by hand in the web app.
- The CLI serialises state writes, Keep local, uploads and disconnect with the shared cross-process file lock; a lock left by a killed run is taken over after 12 seconds, and waiting for it ends after 30 seconds.
- The plugin allows 90 s for local calls, 300 s for connect, update, a one-provider sync and disconnect, and the same 300 s for each provider of Sync all, which makes one call per provider in turn, so one provider failing or timing out does not stop the others. Sessions run with `-p` or the SDK do not scan the machine.
- Tests: `hooks/integrations.test.tsx` (`claude plugin test .`).
- Team workspace skills as Claude Code skills, in both the MCP and CLI modes. At session start `hooks-handlers/sync-workspace-skills.py` copies the skills of the Altimate workspace linked to the project (from `.altimate-code/skill/_workspace/`) into `.claude/skills/`. Copies keep only `name` and `description` from the frontmatter, have `!` command blocks disarmed, leave out files Claude Code reads as hooks, agents, commands or settings, are served only for the Altimate account the user is signed in to (tenant, URL and key digest), never replace a skill the user wrote (copies carry a marker file; a name clash skips the workspace skill), and get a `.gitignore` so they stay out of version control. When the workspace drops a skill, its copy is removed. The SessionStart context mentions the project skills when copies exist.
- A project that was never synced, or not for an hour, is refreshed by a detached `altimate workspace refresh` that the hook does not wait for. It is bounded by a per-project lock that expires after ten minutes, and it is skipped silently when no CLI is on PATH or the project has no `.altimate-code` directory. Claude Code's skill watcher loads the copies when it finishes.
- The SessionStart context lists each workspace skill copy with its description (250 characters per skill, 4,000 in all; past that, a count of the rest). Claude Code shows skill descriptions only while its skill listing fits a size budget (about 1% of the context window), and past it project skills appear as bare names that Claude cannot match to a request.
- `ALTIMATE_CLAUDE_SKILL_SYNC=0` turns the skill copy and refresh off.
- Tests: `tests/test_sync_workspace_skills.py` (`python3 -m pytest tests/`).
- `hooks-handlers/refresh-skills.sh` holds the refresh: `--if-stale` starts it in the background only when the snapshot is missing or over an hour old, `--wait` refreshes now and reports how many workspace skill copies are present. SessionStart never waits on the network.
- A Stop hook runs the same hourly background refresh in long sessions, so updated or removed workspace skills reach the session.
- `/altimate-code:refresh-skills` refreshes the workspace skills on demand.
- Tests: `tests/refresh-skills.sh`.

- How the copies stay safe: they are served only for the signed-in Altimate account (tenant, URL and the CLI's credential digest); concurrent sessions, refreshes and the CLI's own copy take turns under one renewed `mkdir` lock in `.claude/skills` and swap each copy with rollback; a snapshot or credentials that cannot be read, a listed skill directory that is gone, or a snapshot briefly missing or replaced while the CLI swaps in a new one, leaves the copies alone; symlinked snapshot files and nested `CLAUDE.md` files are not copied; a skill folder without the `.altimate-workspace-skill` marker is never touched; staging left by a killed sync is removed. `ALTIMATE_CLAUDE_SKILL_SYNC=0` also removes the copies.
- Refresh is per account: a failed refresh is retried at most hourly, and a newly signed-in account refreshes at once. `/altimate-code:refresh-skills` reports when another refresh still holds the lock instead of running alongside it.
- The mode check reads MCP policy as Claude Code applies it (`managed-mcp.json`, `managed-settings.d/`, merged `allowedMcpServers` and `deniedMcpServers` by name or command, `allowManagedMcpServersOnly`, servers turned off in `/mcp`), and the CLI-mode guidance names the executable on PATH (`altimate` or `altimate-code`).
- The opt-in warehouse guard (a best-effort nudge, not a security control) allows only a lone `altimate` command, judges each client call by its own arguments and that client's query flags (`psql -tAc` included), and also catches command and process substitution, client paths and quoted names, shell keywords, `sudo`/`env`/`time`/`timeout` wrappers and variable prefixes, `sh -c`, `bq` global flags and DuckDB SQL arguments.

- MCP registration (`.mcp.json`): the `altimate-code` stdio server runs `altimate-code mcp serve`, read-only by default. Tools: `warehouse_list`, `warehouse_add`, `sql_execute` (`tables` returns schemas and value profiles in the same call), `sql_materialize`, `answer_commit`, plus `impact_analysis`, `dbt_lineage`, `altimate_core_column_lineage`, `schema_detect_pii`, `data_diff`, `altimate_core_equivalence` and `sql_translate`. It needs an altimate-code build that contains `mcp serve`, and the CLI on PATH as `altimate-code`; curl installs expose only `altimate`, so they need an `altimate-code` link for the server to start (the CLI mode works either way).
- The skill, `/altimate-code:altimate`, the `analyst` agent and the SessionStart text describe two modes. When tools named `mcp__plugin_altimate-code_altimate-code__*` are available, they are used. When they are not (an organisation's managed settings disallow MCP servers, the server failed to start, or the build lacks `mcp serve`), the same tools run through `altimate tool run`, starting with one `tool context` call that prints the connections, schema listing and analyst method. An organisation that blocks MCP therefore still gets every tool.

- SessionStart picks the mode without starting the CLI (`hooks-handlers/data-mode.sh`). It uses the CLI mode when `altimate-code` is not on PATH, when managed, user or project settings deny the server (`deniedMcpServers`, or an `allowedMcpServers` list without it; `disabledMcpjsonServers` covers only a project's own `.mcp.json` servers, so it is not read), or when `ALTIMATE_DATA_MODE=cli`; `ALTIMATE_DATA_MODE=mcp` forces the MCP mode. Only the CLI mode adds the project routing guidance (the same text `altimate-code link --claude-md` writes to `CLAUDE.md`); the MCP mode adds none.
- Tests: `tests/data-mode.sh`.
- Linked Altimate workspaces in both modes, without an altimate-code agent. The MCP server starts with `--workspace-tools`, and in CLI mode every `tool run`, `tool list` and `tool schema` call passes `--workspace-tools` (one warm tool process per project). Claude uses `workspace_context` (setup status, receipt, summary, skills, memory and, with `include_tools`, the operation catalog), `workspace_skill` and `workspace_execute` (`ask_knowledge_base`, workspace warehouse connections and read-only queries). The skill covers setup statuses (`needs_auth`, `needs_workspace`, `disabled`, `unavailable`, `needs_engine`), receipt refresh, engine installation only after the user agrees, linking with `ALTIMATE_DISABLE_MEMORY=1`, skill list/refresh/publish, and memory saving only on explicit request through `workspace-client remember`. Older CLIs without `--workspace-tools` keep delegating workspace questions to `run`.
- Tests: `tests/workspace-tools.sh` (static checks; with `ALTIMATE_TEST_BIN`, a live check against a CLI build).

- Opt-in PreToolUse hook `warehouse-guard.sh`, active only when `ALTIMATE_ROUTE_GUARD=1`. It denies Bash commands that query a warehouse directly and suggests the matching `tool run`. `altimate` commands, dbt and file operations pass. Needs `python3`.
- `analyst` agent: a read-only data analyst that works through `tool run`.
- Tests: `tests/warehouse-guard.sh`.

### Changed

- Managed MCP policy is also read from `C:\Program Files\ClaudeCode` on Windows; a background or `--wait` refresh releases its lock when it exits or is stopped; the opt-in guard's hint also says how to run a write (`--allow-write` after the user agrees, or `altimate run`).
- The skill, the `analyst` agent and the CLI-mode SessionStart text describe the three workspace features in both modes: team skills as project skills, conventions, knowledge and memory through `workspace_context`, and warehouse reads through `workspace_execute`. With a CLI that turns workspace tools on in linked projects, `tool context` also prints the workspace name and its team skills; the plugin still passes `--workspace-tools` so older CLIs work.

- The `analyst` agent works in both modes and ends with `FINAL ANSWER:`, optionally recorded with `answer_commit`.
- `/altimate-code:altimate` answers data questions with the MCP tools when present and otherwise delegates with the `analyst` agent; long jobs use `builder`.

- The `altimate-code` skill now has Claude call the model-free data tools itself with `altimate tool run <name> --args '<json>'` instead of delegating each task to a second agent. It lists which tools fit which question, how to pass arguments, that calls are read-only until the user approves `--allow-write`, and to ask a clarifying question when a request has two readings. Delegation with `altimate run` stays for long multi-step jobs and is the fallback when the CLI has no `tool` subcommand.
- The skill description and SessionStart context describe the tools directly and no longer claim work Claude does well alone.

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
