# Altimate Code — Claude Code plugin

Gives Claude Code direct access to the model-free data tools of [altimate-code](https://github.com/AltimateAI/altimate-code), an open-source CLI with 100+ deterministic data-engineering tools: column-level lineage and impact analysis, PII detection, data-diff and parity, FinOps and query cost, query equivalence, dialect translation, and queries and schema inspection on connected warehouses.

**Why call the tools directly?** Claude reasons, the tools compute. Neither the MCP server nor `altimate tool run` runs a second LLM, so there is no second agent's model to pay for: on workspace questions this cost 12% less per run than delegating, at the same accuracy (benchmark in the PR that introduced it). Long multi-step jobs (dbt builds, migrations) can still be delegated with `altimate run`.

**Two modes, one set of tools.**

| Mode | When | How |
|---|---|---|
| MCP | The session has the plugin's MCP tools (`mcp__plugin_altimate-code_altimate-code__*`) | Claude calls them directly. The plugin's `.mcp.json` runs `altimate-code mcp serve`, read-only by default. |
| CLI | The MCP tools are not available | Claude runs `altimate tool context` once, then `altimate tool run <name> --args '<json>'` through Bash. |

The CLI mode is what keeps the plugin useful for an organisation that disallows MCP servers through managed settings (for example `allowedMcpServers` or `deniedMcpServers`): the plugin's server is then not started, and Claude uses the same tools through the shell. When the server fails to start or the installed build has no `mcp serve`, the session stays in the MCP mode without the routing guidance, and the skill still falls back to `tool run`. At session start the plugin decides which mode applies without starting the CLI: the CLI mode when `altimate-code` is not on PATH, a `managed-mcp.json` is present, settings deny the server (`deniedMcpServers`, or `allowedMcpServers` that admits neither its name nor its command, read as Claude Code merges them, including `managed-settings.d/` and `allowManagedMcpServersOnly`) or it was turned off in `/mcp` for the project, otherwise MCP. Policies delivered only by an MDM profile or the Windows registry are not read; set `ALTIMATE_DATA_MODE=cli` there (`ALTIMATE_DATA_MODE=cli|mcp` overrides). In the CLI mode it also adds the project routing guidance to the session, so the project's `CLAUDE.md` does not need it; `altimate-code link --claude-md` can still write it there for other clients. The MCP mode adds no routing guidance.

## Install

```bash
claude plugin install altimate-code --marketplace AltimateAI/altimate-claude-plugin
```

## Update

```bash
claude plugin marketplace update altimate-claude-plugin
claude plugin update altimate-code@altimate-claude-plugin
```

Then restart Claude Code.

## Prerequisites

The altimate-code CLI must be installed and configured on your PATH. Either install method works:

```bash
npm install -g altimate-code                       # requires Node 20+; exposes `altimate` and `altimate-code`
curl -fsSL https://www.altimate.sh/install | bash  # standalone binary; exposes `altimate` and `altimate-code`
altimate                                           # launch the TUI, then run /connect to configure your LLM provider
```

The CLI mode invokes `altimate`, the CLI's canonical name, and falls back to `altimate-code` for npm installs older than v0.7.1, so standalone installs work without an alias.

**MCP mode and the CLI name.** The MCP registration launches `altimate-code mcp serve`. npm, Homebrew and current curl and PowerShell installs expose both names, but curl and PowerShell installs older than v0.12.8 expose only `altimate`: there the server cannot start until `altimate-code` is on PATH (for example `ln -s "$(command -v altimate)" ~/.local/bin/altimate-code`), and Claude uses the CLI mode meanwhile. MCP mode also needs a build that contains `mcp serve`; check with `altimate-code mcp serve --help`. Direct MCP and `tool run` need no LLM provider; only delegation (`altimate run`) does.


Or configure a provider via environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and 20+ others — see the [altimate-code docs](https://docs.altimate.sh)).

If altimate-code is not on PATH or not configured, the plugin surfaces the failure with fix instructions rather than silently falling back to Claude's native tools.

## How it works

1. A **SessionStart hook** adds a description of the available tools and both modes to the session, and copies the linked workspace's skills (see below). It does not start the MCP server. In a linked project, the [team rules](#team-rules) hooks add the workspace's rules too.
2. **MCP mode.** Claude calls `warehouse_list`, `warehouse_add`, `sql_execute` (`tables` returns columns and value profiles; large results spill to a local file), `sql_materialize` (session-local `scratch` DuckDB for cross-database joins), `answer_commit`, and `impact_analysis`, `dbt_lineage`, `altimate_core_column_lineage`, `schema_detect_pii`, `data_diff`, `altimate_core_equivalence`, `sql_translate`.
3. **CLI mode.** The **skill** has Claude run `altimate tool context` once (connections, schema listing, analyst method), then `altimate tool run <name> --args '<json>'` through Bash and reason over the structured output. `altimate tool list --json` shows every tool and its input schema. A warm process per project starts automatically.
4. Calls are read-only unless you approve `--allow-write` (CLI mode); `DROP DATABASE`, `DROP SCHEMA` and `TRUNCATE` are always blocked. Read-only is enforced by the database on Postgres, SQLite and DuckDB and by SQL classification elsewhere, so use a read-only DB user for the strongest boundary.
5. For long multi-step jobs, or when you invoke **`/altimate-code:altimate <task>`** for work that needs the agent, Claude Code runs `altimate run "<your task>"` locally with the `builder` agent (or `analyst` for a data question when MCP is unavailable), which uses your configured LLM provider.
6. Warehouse queries and dbt commands run **locally under your credentials**. If the installed CLI predates the `tool` subcommand, the skill falls back to delegation.

Connections come from project and global `.altimate-code/connections.json` files and `ALTIMATE_CODE_CONN_*` environment variables. To pin a file for the MCP server, change the `args` in `.mcp.json` to `["mcp", "serve", "--workspace-tools", "--connections", "/absolute/path/to/connections.json"]`.

### Optional: route warehouse queries to the tools

Set `ALTIMATE_ROUTE_GUARD=1` to enable a PreToolUse hook that denies Bash commands querying a warehouse directly (`psql -c`, `trino --execute`, `docker exec ... clickhouse-client`, `snowsql`, `bq query`) and suggests the matching `tool run`. It is off by default and a best-effort nudge, not a security control: it never blocks a lone `altimate` command, dbt, or file operations, while `altimate` chained with other commands is checked like any command. Quoted text (a commit message, say) is never taken as a command, but a `$(...)` or backtick substitution inside it is. It needs `python3`; without it every command is allowed.

### Optional: analyst agent

`claude --agent altimate-code:analyst` starts a read-only data analyst that answers questions through the MCP tools when present and `tool run` otherwise, and ends with a `FINAL ANSWER:` line.

## Use an Altimate workspace

An [Altimate workspace](https://help.altimate.ai/workspaces/) holds your team's shared skills, knowledge, memory and warehouse integrations. Claude reaches the workspace linked to the project directly, with three tools that run no model of their own (knowledge questions are answered by Altimate's backend models) and work the same over MCP and through `altimate tool run --workspace-tools`:

- `workspace_context` reports whether sign-in or linking is needed, and once linked gives the workspace summary, skill names, bounded project memory and (with `include_tools`) the knowledge and warehouse operations available.
- `workspace_skill` reads one shared skill.
- `workspace_execute` runs one of those operations: `ask_knowledge_base`, listing the workspace's warehouse connections, or a read-only query on them. Writes are refused.

Claude does the reasoning; no altimate-code agent runs. Knowledge questions are answered by Altimate's backend. Each call carries a workspace receipt from `workspace_context`, so a change of account or link is detected before anything runs. Workspace tools need an altimate-code build with the `tool` CLI and `--workspace-tools`; with an older CLI, workspace questions are delegated to altimate-code, which uses the workspace automatically.

1. **Sign in to Altimate** — `altimate auth login -p altimate-backend --method "Altimate LLM Gateway"` (`altimate-code` on npm installs older than v0.7.1). It opens your browser. This also sets up the model provider altimate-code uses. You can run it from Claude Code by typing it after `!`.
2. **Link the project** — ask Claude to link the project to your workspace. It shows the workspaces `workspace_context` (or `altimate workspace list`) returns and links the one you choose with `altimate link --workspace "<id or name>"`, or creates one with `altimate link --create`. Claude links with `ALTIMATE_DISABLE_MEMORY=1`, so existing memory on this machine is not uploaded. Moving a linked project to a different workspace also needs `--yes`. `workspace list` is in newer altimate-code releases; with an older one, tell Claude the workspace's name. In a terminal, `altimate link` does the same with a picker; the picker does not work after `!` in Claude Code.
3. **Check it** — `altimate workspace status` shows the linked workspace, how much memory has reached it and when its skills last synced.
4. **Ask Claude** — questions about your team's conventions, definitions or knowledge, and queries on the workspace's warehouses, use the workspace tools: *"How do we define recurring revenue?"*, *"Which Snowflake connections does our workspace have?"* Start a request with `/altimate-code:altimate` to be sure it does.
5. **Workspace engine** — knowledge and warehouse operations need the workspace engine. If it is missing, Claude asks before installing it with `altimate workspace-client engine-install` (Node.js 20+ and npm).

**Team skills as Claude Code skills.** In both modes, session start copies the linked workspace's skills into the project's `.claude/skills/`, so they load like any project skill. Copies keep only each skill's name and description from the frontmatter, have `!` command blocks neutralised and are served only for the Altimate account you are signed in to. A skill you wrote with the same name is never replaced or removed (to customise a team skill, copy its folder under a new name and delete the `.altimate-workspace-skill` file in the copy), and the copies are kept out of git. A project that was not synced, or not attempted, for an hour is refreshed in the background (`altimate workspace refresh`); the skills show up when it finishes. Set `ALTIMATE_CLAUDE_SKILL_SYNC=0` to turn the copy off; the next session start then removes the copies. The altimate CLI copies skills only when the plugin's refresh asks it to, so this one setting covers both. Uninstalling the plugin leaves them in place: delete the `.claude/skills/` folders that contain `.altimate-workspace-skill`.

**Skills and memory.** Ask Claude to list skills (`altimate skill list`), pull the latest (`altimate workspace refresh`) or share a project skill you name (`altimate skill publish <name>`; replacing needs your confirmation). Claude saves a memory to the workspace only when you ask, after showing you the workspace, id and text, with `altimate workspace-client remember`. What altimate-code learns during delegated `run` tasks is saved to the workspace's memory as before.

## One-click integrations

The plugin finds GitHub, Jira and Linear credentials you already have and connects them without retyping them:

- `gh`, jira-cli and Linear credentials on this machine, and GitHub, Atlassian or Linear MCP servers configured in Claude Code, are detected when a session starts.
- A band above the prompt offers **Connect**, **Keep local**, **Review** or **Later** for what it found, and shows **Token rejected · Update** when a saved token stops working. The status line shows how many integrations are connected.
- `/integrations` opens a side pane with one row per provider. **Add credentials** (or **Update**) opens a short form: type the non-secret fields, then **Create token ↗** opens the provider's token page and **Paste from clipboard** stores the token (shown masked afterwards). **Connect & sync** saves it, **Keep local** saves it without syncing, **Cancel** discards the form.
- A connected row offers **Sync**, **Allow sync** (after Keep local) and **Disconnect**. In a folder not linked to a workspace, **Link workspace** lists your workspaces and links the one you pick. When you are not signed in to Altimate, everything works locally: Connect behaves as Keep local, the sync buttons are hidden, and the band and pane offer **Sign in to sync**, which opens the browser sign-in on that click only.
- **Keep local** blocks syncing for that provider: the credential stays in your OS keychain and is never sent to Altimate, not even by **Link workspace** or **Sync all**, until you press **Allow sync**. For a provider that is not kept local, **Link workspace** and **Sync all** upload nothing over a connection this tool already made in your workspace: they only attach it to the linked workspace, also when this machine has no record of it, unless the workspace marks it invalid. A connection saved to your workspace has no local copy, so its row has no **Keep local** button of its own. Open **Update**: the form also offers **Keep local** (paste the token again), and pressing it removes the workspace connection this tool made and keeps the credential here. **Disconnect** followed by **Add credentials** with **Keep local** does the same. If the workspace cannot be read, Keep local is refused with the reason and nothing is moved or removed. If the credential is kept on this machine but the workspace copy could not be removed, a warning says so; remove it in the workspace. A credential checked while the provider is unreachable is kept only with **Keep local**, marked not verified yet. **Disconnect** says when the connection could not be taken off the linked workspace. A token the provider or the workspace rejects is not kept: a new connection the workspace marks invalid is removed again, and an update it rejects leaves the existing connection marked rejected. For a credential saved to the workspace the row shows the most recently validated connection; a credential kept on this machine is shown as stored here. **Update** and **Disconnect** act on the one this tool made. A clipboard holding a URL is not taken as a token. **Sync** and **Sync all** test the credential with its provider first and upload nothing when it is rejected or the provider cannot be reached. On macOS a secret that cannot be written to the keychain is not stored at all, never written to a file.

The side pane and band need a Claude Code build with hooks modules and `altimate integrations` from altimate-code.

## Lineage beside the chat

The plugin's lineage pane follows the dbt model Claude reads or edits (by Read, Edit, a shell command that names or finds its `.sql` file, or a `dbt_lineage` call), read from `target/manifest.json` with no model calls. A project with no manifest still gets its graph, read from the models' `ref()` and `source()` calls; columns, dashboards and column reach then need `dbt parse` or `dbt compile`. From a monorepo's root, `/lineage <model>` finds the dbt project below it that has the model:

- **The graph.** The model's whole lineage as boxes and arrows, like dbt-lineage-viewer: every level upstream on the left and downstream on the right, every model, every name in full, dashboards (exposures) marked ◆. The pane is a window onto the drawing. A graph too big for Claude Code to draw in a pane is shown as folders instead, and the header says so; `v` switches to the other views. Scroll it up and down with the mouse, touchpad or arrow keys, pan it with `h` and `l` (or ◀ ▶), and `f` brings the model back to the middle. Links between models on the same level, or that skip a level, are not drawn. Press a model to follow it. With a column picked, the models and dashboards that read it are highlighted and the rest dimmed.
- **Views for big projects.** `v` cycles the graph, **ends only** (the sources and dashboards the model sits between; "via N" counts the models between them on the shortest path), **folders** (sources, staging, intermediate, marts and dashboards as one box each, with counts, in dbt layer order: a source-to-mart chain on one screen) and the text **list** of upstream and downstream. A pane narrower than 48 columns shows the list. The pane keeps up to 500 models upstream, and through altimate-code (a manifest over 4 MiB) up to 500 downstream too; past that the header says which side was cut.
- **What the answer is about.** Once the session has seen a dbt project, after each answer the models Claude named are listed under the header (IN THE ANSWER), each a press away. When Claude answered without reading any model that turn (from what it read earlier), the pane follows the first model it named, so the lineage shown matches the answer.
- **Columns.** Each output column with its source columns and how it is derived, from altimate-code's `dbt_lineage`, read from the compiled manifest (`dbt compile`). The plugin's calls are read-only, so altimate-code never starts the project's dbt adapter for them.
- **Column reach.** `c` picks a column; the pane shows the downstream models whose SQL reads it and the dashboards on them, from `impact_analysis` (it traces each downstream model's compiled SQL, renames included). Models that name the column only in a filter or join, or that could not be traced (no compiled SQL), are listed apart, and the count is then a lower bound.
- **Impact first.** Before an edit to a model's SQL lands, the plugin checks what reads the model and the reach of every column the edit touches (up to three, merged). It tells a touched column from the model's own lineage (what the pane already read, or `dbt_lineage` through the CLI), so a column `schema.yml` leaves out still counts. It shows the result as a toast, adds it to Claude's context with the edit's result, and leaves a band above the prompt with the severity (impact_analysis' thresholds) and counts.
- **Warehouse lineage.** When a connected MCP server offers Altimate's `table_lineage` (Snowflake) or `databricks_table_lineage`, the pane adds what the warehouse's query history shows for the model's table. The plugin calls a tool of that name on whichever connected server offers it, itself and without a permission prompt, and sends it the model's `database.schema.table`. It does so only when you ask for the model (`/lineage`, a press in the pane, or `r`), never when the pane follows one of Claude's reads.
- **Claude's own lineage calls.** A `dbt_lineage` result is drawn as a list of edges colored by how each column is derived; ctrl+o keeps the original output under it.

`/lineage <model>[.column]` opens the pane on a model, at any width. When the pane follows Claude's reads on its own, Claude Code draws it only in a terminal at least 144 columns wide (110 once you have opened it yourself); in a narrower one it waits, and a toast says so once. Lineage calls go to the plugin's MCP server without a permission prompt, or to `altimate tool run` when the server is not available. A manifest over 4 MiB is read through altimate-code (`dbt_lineage` with `include_graph`). Run `dbt parse` or `dbt compile` first; column lineage and reach need compiled SQL. When the shown model's `.sql` file changed after the manifest was written, the pane and the edit note say so: run `dbt compile`, then `r`.

### Team rules

In a project linked to an Altimate workspace, the workspace's approved **team rules** apply to Claude Code itself, not only to the tasks it hands over. With learning on (`altimate learn enable` in the project, or the workspace's "Learn from sessions" if you have made no choice of your own), your corrections can become proposed rules too:

- **At session start** the plugin gives Claude the team rules for this repository, tells it how many proposed rules are waiting for you, and reports the owner's reviews of your proposals since your last session (approved, or rejected with the reason).
- **When you correct Claude** ("no, we never use FLOAT for money") the correction is recorded locally. When you correct it on the same topic in two sessions, or correct a team rule it was given, altimate-code words a proposed rule after the turn, in the background.
- **"Remember this as a team rule: …"**, said to Claude, waits as a proposal the same way. It needs "as a rule" or "team rule" followed by ":" or "-": "remember to run the tests", a question, or "don't remember this as a team rule" is just part of the conversation. A task handed to altimate-code decides this as an altimate-code session does.
- **`/altimate-code:rules`** shows the proposals waiting for you, the team rules, and the status of the rules you proposed. For each proposal you choose: send it to the workspace owner's review (or approve it, if you are the owner), edit the wording, save it as a memory, or "Not a rule". Nothing reaches teammates until the owner approves it.

Rule drafting uses altimate-code's own model (sign in to the Altimate LLM Gateway, or set a provider in altimate-code): if it has none it can use, the next session start says the check failed. The same commands work in a terminal: `altimate learn proposals`, `altimate learn proposals reply <id> --send`. Proposals from Claude Code sessions are answered only there or with `/altimate-code:rules`: altimate-code's own `/rules` and its VS Code chat panel don't list them. This needs an altimate-code release with workspace rules.

- **Start the session in the linked folder**, or a folder below it. If only a folder inside the repository is linked (a dbt project), a session started at the repository root gets no team rules.
- **A new clone or worktree** gets no team rules until altimate-code has been linked, or run, in that checkout: the link is remembered per folder.
- **The per-turn hooks never block**: they hand off to altimate-code in the background. Session start makes one bounded synchronous call (at most 15 seconds). All of them run only in a linked folder (or below it), as recorded in altimate-code's link cache in your own state directory: nothing in the repository turns them on.
- **`ALTIMATE_LEARN=0`** turns all of it off: the hooks start nothing.

## dbt helpers

What dbt Power User does in VS Code, inside the Claude Code session. Each helper runs the project's own dbt (`.venv` or `venv` in the project folder, `bin/dbt` or `Scripts\dbt.exe`, else `dbt` on `PATH`), one at a time per project, and calls no model:

- **Compile and validate, on every edit.** After Claude edits or writes a model's `.sql` file, the plugin runs the model with `dbt show --limit 1`: dbt compiles it and the warehouse runs it, so a Jinja error or a column the warehouse does not have shows at once. The columns the query returns are held to the ones `schema.yml` documents. The result goes to Claude with the edit's result (it waits up to 30 seconds; a slower check rides on Claude's next tool result) and stays above the prompt. When the query returns no row, or `schema.yml` documents no columns for the model, the check says the columns were not compared rather than calling them a match. When the check finds a problem, the **dbt check** pane opens beside the chat (**Details** brings it back): every column the warehouse returned against the ones `schema.yml` documents, or dbt's full error, with **Check again**. When the model's file or its schema file changes afterwards outside Claude's edits (a fix altimate-code made), or Claude edits a schema file or another SQL file (a macro), the check runs again; when the model's file is deleted, its check is dropped. Macros, tests and analyses are not run.
- **A failed run, one press from a fix.** When a `dbt run`, `test`, `build`, `seed` or `snapshot` that Claude ran fails, the failed nodes (from `target/run_results.json`, or dbt's own text when the run wrote none) show above the prompt with **Explain**, which asks Claude to explain each failure without changing files, and **Fix with Altimate Code**, which hands them to `/altimate-code:altimate`. A passing run of the same kind (or a build) with the same selection, or of the whole project, clears it.
- **Query results in a pane.** Rows from a `dbt show` Claude runs, and from `/dbt-show <model>` or `/dbt-show select …` (50 rows), open as a table beside the chat. **Re-run** runs it again: Claude's own `dbt show` with the same flags in the same order, from the folder Claude ran it in, with the same limit (a bare `dbt`, as an activated venv or `uv run` leaves it, runs as the project's own dbt; a command that depended on its shell (a variable, `~`, a glob, an environment prefix, or other commands before it than `cd` and activating the project's `.venv`) offers no Re-run), or your `/dbt-show` query, **Bookmark** keeps it, and the pane lists your bookmarks and the last 20 queries. They are kept on this machine in Claude Code's plugin store, up to 50 rows each, across sessions; **Clear history** forgets every query that is not bookmarked.
- **Model context, before Claude guesses.** When Claude reads a model's `.sql` file, the model's materialization, relation, columns (types, descriptions and tests), model tests, parents, children and depth upstream and downstream, from `target/manifest.json`, go to Claude with the file, once a turn. A manifest over 4 MiB is read for that model through the project's Python. A file newer than the manifest is said to need `dbt parse`.
- **An environment doctor at session start.** The plugin checks dbt-core, the Python that runs it, whether the profile's adapter is installed, whether `packages.yml` has been installed, and whether the manifest is older than the project's files or lists a file that is gone (from the folders and `target-path` dbt_project.yml names, and the profiles.yml dbt itself reads). Anything wrong shows above the prompt with **Run dbt parse** or **Run dbt deps**, and Claude is told with your first prompt. `/dbt-doctor` opens the checks in a pane and also tests the warehouse connection (`dbt debug`), which session start never does.

Compile and validate runs a query on your warehouse after every model edit (`dbt show --limit 1`). On a warehouse that bills by bytes scanned or wakes a suspended warehouse for it, that costs money. Set the plugin's `dbt_mods` option to false (in `/config`) to turn all of the helpers off.

## Example prompts

Once installed, try these in Claude Code (or prefix any of them with `/altimate-code:altimate`):

1. **Column-level lineage** — *"Trace the `revenue_usd` column in `models/marts/fct_revenue.sql` back to its sources, and list every downstream model that would be affected if I change its rounding."*
2. **Warehouse cost analysis** — *"Give me a cost report for our Snowflake account: the ten most expensive queries this month and any warehouses that look over-provisioned."*
3. **Cross-dialect validation** — *"Compare `prod.orders` in Snowflake with `analytics.orders` in BigQuery row-by-row using `id` as the key, and summarize any mismatches."*
4. **dbt test generation** — *"Generate dbt tests for `models/staging/stg_orders.sql`, including unit tests for the CASE/WHEN logic."*

## Data handling

MCP tools and `tool run` run locally under your credentials; tool results Claude reads enter the Claude Code conversation and reach its model provider. Neither makes an LLM call of its own.

The dbt helpers run the project's dbt on this machine. What they add to Claude's context (dbt's errors, column names, the manifest's facts about a model) reaches its model provider like any tool result. The rows of the results pane are kept on this machine only, in Claude Code's plugin store, until you clear them.

Delegating a task with `altimate run` passes your prompt text to the altimate-code CLI, which sends it to your configured LLM provider — the Altimate LLM Gateway by default, or your own provider (BYOK), in which case Altimate never sees it. Warehouse credentials and query results stay on your machine.

Full details: **[PRIVACY.md](../../PRIVACY.md)** · Security policy and disclosure: **[SECURITY.md](../../SECURITY.md)** · Terms: **[TERMS.md](../../TERMS.md)**

## Troubleshooting

| Symptom | Fix |
|---|---|
| Neither `altimate-code` nor `altimate` on PATH | `npm install -g altimate-code` (Node 20+) or `curl -fsSL https://www.altimate.sh/install \| bash`, then run `altimate` once to configure your provider. |
| MCP tools missing from the session | Managed settings may disallow MCP servers, `altimate-code` may not be on PATH (curl and PowerShell installs older than v0.12.8 expose only `altimate`), or the build lacks `mcp serve`. Claude falls back to `altimate tool run`, so no action is required. |
| `Unauthorized` / `No provider configured` | Run `altimate` (`altimate-code` on npm installs older than v0.7.1) to open the TUI and reconfigure your provider via `/connect`, or set the provider API key env var. |
| Task hangs for several minutes | Open `altimate` (`altimate-code` on npm installs older than v0.7.1) to check for a pending prompt in the TUI, or re-run specifying a known-good model. |
| Empty result | The task may be too ambiguous — restate with the target table, expected columns, or time window. |
| `UNKNOWN_USER` / `Database does not exist` mid-run | The CLI connects but your warehouse credentials don't match this project — reconfigure warehouse auth in the `altimate` TUI (`altimate-code` on npm installs older than v0.7.1) or `profiles.yml`. |
| `Not signed in to Altimate` | Run `altimate auth login -p altimate-backend --method "Altimate LLM Gateway"` (`altimate-code` on npm installs older than v0.7.1). |
| Answers ignore your workspace's skills or knowledge | Run `altimate workspace status` in the project. If it isn't linked, ask Claude to link it, or run `altimate link` in a terminal. If it is linked, check that your CLI has `tool run --workspace-tools` (`altimate upgrade`). |
| `Altimate account or workspace changed` | The sign-in or link changed since Claude read the workspace. Claude re-reads `workspace_context` and retries once; if it repeats, ask Claude to check `altimate workspace status`. |
| Workspace engine `needs_engine` | Let Claude run `altimate workspace-client engine-install`, or run it yourself. |
| Team rules don't appear at session start | Check `altimate learn status` in the project: it needs a linked workspace and an Altimate sign-in, and `ALTIMATE_LEARN` not set to `0`. Start Claude Code in the linked folder (or below it), not at the repository root when only a subfolder is linked. Update altimate-code if `altimate learn rules` is an unknown command. |
| Plugin installed but never delegates | Confirm it's enabled: `claude plugin enable altimate-code@altimate-claude-plugin`. |

Still stuck? See [Support](#support).

## Components

- **MCP server** — `.mcp.json` — `altimate-code mcp serve`, read-only by default
- **Skill** — `skills/altimate-code/SKILL.md` — MCP and `tool run` guidance, delegation for long jobs, workspace guidance
- **Agent** — `agents/analyst.md` — read-only data analyst (MCP or CLI)
- **Command** — `commands/altimate.md` — `/altimate-code:altimate` slash command for explicit delegation
- **Command** — `commands/rules.md` — `/altimate-code:rules` to answer proposed team rules
- **Hooks** — `hooks/hooks.json` — SessionStart capability description and workspace skill copy; Stop hook hourly background skill refresh; the team rules hooks (`hooks-handlers/workspace-rules.sh`): SessionStart, UserPromptSubmit and Stop, which call `altimate learn hook <event>` and never fail the session (the per-turn hooks run in the background; session start waits at most 15 seconds); opt-in PreToolUse `warehouse-guard.sh` (needs `ALTIMATE_ROUTE_GUARD=1`)

## Support

- **Docs:** [docs.altimate.sh](https://docs.altimate.sh)
- **Issues:** [GitHub Issues](https://github.com/AltimateAI/altimate-claude-plugin/issues)
- **Community:** [Slack](https://altimate.studio/join-agentic-data-engineering-slack)
- **Email:** support@altimate.ai · security reports: security@altimate.ai

## License

MIT — see [LICENSE](../../LICENSE).
