# Altimate Code — Claude Code plugin

Use [altimate-code](https://github.com/AltimateAI/altimate-code) data tools directly
from Claude Code through MCP. **Claude Code does the reasoning and carries the
LLM cost** for data questions; the stdio MCP server runs no LLM. Long multi-step
jobs such as dbt project builds, migrations, and FinOps reports can still be
delegated to `altimate-code run`, which uses its own agent and configured provider.

**1.3.0-experimental: direct MCP use requires an altimate-code build with `mcp serve`.**
This server is in an unreleased branch. Released builds without `mcp serve` fail
to start the MCP server; the plugin falls back to `altimate-code run` with the
analyst persona for data questions. It tells you which path is being used.

## Install

From Anthropic's plugin directory:

```bash
claude plugin install altimate-code
```

Or from this repository's marketplace:

```
/plugin marketplace add AltimateAI/altimate-claude-plugin
/plugin install altimate-code@altimate-claude-plugin
```

## Prerequisites

Put the CLI on PATH where Claude Code can launch it (it requires Node 20+). Either install method works:

```bash
npm install -g altimate-code                       # exposes `altimate` and `altimate-code`
curl -fsSL https://www.altimate.sh/install | bash  # standalone binary; exposes `altimate`
```

The delegation skill and commands invoke `altimate`, the CLI's canonical name, and fall back to `altimate-code` for npm installs older than v0.7.1. The MCP registration launches `altimate-code mcp serve`: for direct MCP use, install a build containing `mcp serve`. Check your build with `altimate-code mcp serve --help`; an unknown command means the MCP server cannot start and data questions use CLI delegation instead. Installing the latest published npm package alone does not provide the unreleased server.

Configure database connections as described below. Direct MCP use does **not**
require an altimate-code LLM provider or API key. For delegated jobs only, run
`altimate` to configure its provider (or use its provider environment settings, such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`).

## How it works

The plugin's `.mcp.json` registers the `altimate-code` stdio server by running
`altimate-code mcp serve`, without `--allow-write`. Claude calls these tools directly:

| Tool | Purpose |
|---|---|
| `warehouse_list` | List available connections; for local databases also tables, columns and a sample row. |
| `warehouse_add` | Add a connection when none is configured or one is missing. |
| `sql_execute` | Execute SQL, read-only by default; `queries` batches independent queries and `tables` returns columns and value profiles (frequency-ranked values, distinct/null counts, unique-in-sample flags, value shapes, MongoDB nested paths) in the same call. Large results spill to a local file path. |
| `sql_materialize` | Copy a read-only query result from any connection into session-local `scratch` DuckDB for cross-database joins. |
| `answer_commit` | Finish a data question with one field per requested item. |

`altimate-code mcp serve --all-tools` also exposes `schema_inspect` and `sql_check`.

For a data question, Claude lists connections, inspects schemas and value profiles,
computes in SQL, checks correctness where needed, and returns the requested values
with a one-line basis. For cross-connection joins, it materializes the smaller
filtered side and other required inputs into `scratch`, then joins there.

The routing skill and `/altimate-code:altimate <task>` prefer this direct
path for answers, numbers, and lists when the MCP tools are available in the
session. If the server is missing or fails to start, they delegate data questions
with `--agent analyst`. Long jobs and capabilities outside the five MCP tools use
`altimate-code run` with persona selection (`analyst` or `builder`)
and a private output file. The plugin tells you which path it uses.
Delegated jobs use the CLI's separate LLM provider,
costs, and rate limits. `/review` retains the specialized dbt/SQL reviewer.
A short SessionStart hook describes these capabilities to Claude.

## Experimental data workspace mod

On Claude Code 2.1.307 (the tested version), this plugin also loads a mod:

- `/altimate-data` opens a pane with recent SQL, connection names, running/completed/error status, and the backend's result text and check findings.
- `/altimate-query <connection> <SQL>` executes SQL directly through the existing MCP tool. For example, `/altimate-query demo SELECT COUNT(*) FROM orders`. Use a connection name without whitespace, as returned by `warehouse_list`. This command makes no model request. Natural-language questions still use Claude's reasoning loop.
- The pane observes Claude's `sql_execute` calls too, without an extra SQL query or rewriting results. Open the pane yourself; it never takes focus automatically.
- `/altimate-workspace` inspects your project and selects an existing workspace. `/altimate-mode on|off|status` controls opt-in workspace context and Altimate routing, with Claude reasoning. `/altimate-remember <id> <text>` explicitly saves one project memory after you inspect the destination. See [workspace data mode](../../docs/workspace-data-mode.md) for setup, costs and verification limits.

The SQL command uses Claude Code's `tool.call` API, retaining tool permissions and the server's existing SQL safety checks, read-only defaults and result linting. It does not use the permission-bypassing `mcp.call` API or start another agent. Workspace commands run the CLI as argument arrays, with memory text on stdin. The mod adds no SQL validation rules. Source writes remain refused by the default MCP configuration; the read-only limitations above still apply. The experimental MCP registration now requires `--workspace-tools` support.

Previews retain only the latest eight calls in memory, with each SQL preview capped at 2,000 characters and result preview at 8,000 characters. Clipping affects the pane only. The model and normal tool result keep the original output. Clear previews with the pane's button or `/clear`; closing the pane only hides it. Conversation end (including resume/logout), reloading the mod, or starting a session clears previews and data mode. Previews and picker state are not persisted. Explicit memory saves, normal Claude transcripts and MCP spill files follow their own retention rules. Previews may contain sensitive query results: screen sharing includes the open pane.

The pane works in the terminal, Desktop and supported VS Code versions; only terminal painting was manually verified. Headless sessions keep text results and do not draw a pane. If mods are disabled by an administrator or hooks settings, these two commands and previews are unavailable; the existing MCP tools and delegation components still work. If the MCP server is unavailable, the direct command reports that no query ran and does not silently delegate to a separately billed model.

Try the draft from a checkout with `claude --plugin-dir ./plugins/altimate-code`. No installation or marketplace change is needed. To compare without the mod, remove `modules` from a **copy** of `hooks/hooks.json`; leave the MCP registration intact. To disable all your own hooks/mods, Claude Code also supports `disableAllHooks`, which disables the existing SessionStart hook too. See [Anthropic's mod controls](https://code.claude.com/docs/en/plugins/mods/overview#turn-mods-on-or-off).

See [the experiment report](../../docs/data-workspace-experiment.md) for measured results and limitations. This is a draft experiment, not a claim that a mod makes Claude's reasoning faster or more accurate.

## Connections

The server uses normal altimate-code discovery: project and global
`.altimate-code/connections.json` files, and `ALTIMATE_CODE_CONN_*` environment
variables. Launch Claude Code in the intended project and make any connection
environment variables available to its MCP subprocess.

To select a connections file explicitly, change the server's `args` in
`plugins/altimate-code/.mcp.json` (or the installed plugin's `.mcp.json`) to:

```json
["mcp", "serve", "--connections", "/absolute/path/to/connections.json"]
```

Use an absolute path to avoid working-directory ambiguity. Connection credentials
are database credentials; they are independent of an LLM provider configuration.

## Read-only default

The plugin does not pass `--allow-write`. Read-only execution is **database-enforced
on Postgres, SQLite, and DuckDB**. Elsewhere it is **SQL-classification-only**;
use a read-only DB user to enforce the boundary in the database. This default is
not a universal database permission guarantee. The CLI supports `--allow-write`
for explicitly enabling writes, but this plugin does not enable it.

`sql_materialize` copies read-only source query results into session-local
`scratch` DuckDB; that local analytical storage does not modify the source
databases. Large results can also be written to local spill files.

## Use an Altimate workspace

An [Altimate workspace](https://help.altimate.ai/workspaces/) holds your team's shared skills, knowledge, memory and warehouse integrations. Claude Code reaches it through altimate-code: every task the plugin hands over runs in your project, so it uses the workspace the project is linked to. Nothing in Claude Code needs configuring.

1. **Sign in to Altimate** — `altimate auth login -p altimate-backend --method "Altimate LLM Gateway"` (`altimate-code` on npm installs older than v0.7.1). It opens your browser. This also sets up the model provider altimate-code uses. You can run it from Claude Code by typing it after `!`.
2. **Link the project** — ask Claude to link the project to your workspace. It lists your workspaces with `altimate workspace list` and links the one you choose with `altimate link --workspace "<id or name>"`, or creates one with `altimate link --create`. Moving a linked project to a different workspace also needs `--yes`. `workspace list` is in newer altimate-code releases; with an older one, tell Claude the workspace's name. In a terminal, `altimate link` does the same with a picker; the picker does not work after `!` in Claude Code.
3. **Check it** — `altimate workspace status` shows the linked workspace and its page in the Altimate web app.
4. **Ask Claude** — questions about your team's conventions, standards or knowledge go to altimate-code, which answers from the workspace. Start a request with `/altimate-code:altimate` to be sure it does: *"/altimate-code:altimate what are our naming conventions for staging models?"*

What altimate-code learns during these tasks is saved to the workspace's memory and shared with your team in the CLI, the IDE and Studio. Skills added to the workspace reach the next task.

## Example prompts

- "How many orders were completed last month? Return the count and total revenue."
- "Join customer activity across our two connections and list the ten most active customers."
- "/altimate-code:altimate Build and test a dbt staging project for these sources."
- "/altimate-code:altimate Produce a warehouse FinOps report with recommendations."
- "/review Review my dbt changes."

## Data handling

MCP tools run locally under your database credentials. Tool results, including
sampled values and query results Claude reads, enter the Claude Code conversation
and are handled by Claude Code's configured model/provider. The MCP server makes
no separate LLM calls. Scratch data and spilled results are local artifacts.

Delegation passes your task to `altimate-code run`; its own configured LLM
provider handles the task and any data supplied to that agent. This is a separate
provider and billing path from direct MCP use.

See **[PRIVACY.md](../../PRIVACY.md)** for MCP and delegation data flows;
**[SECURITY.md](../../SECURITY.md)** and **[TERMS.md](../../TERMS.md)** also apply.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Neither `altimate-code` nor `altimate` on PATH | `npm install -g altimate-code` (Node 20+) or `curl -fsSL https://www.altimate.sh/install \| bash`, then run `altimate` once to configure your provider. Direct MCP tools additionally require a build with `mcp serve`. |
| Unknown `mcp` or `serve` command | The MCP server fails to start; data questions fall back to CLI analyst delegation. Configure the CLI's LLM provider for delegation, or use a build containing `mcp serve` for direct MCP tools. |
| No connections / database access error | Check project/global connection files, `ALTIMATE_CODE_CONN_*` environment variables, and database permissions. |
| `Unauthorized` / `No provider configured` | Run `altimate` (`altimate-code` on npm installs older than v0.7.1) to open the TUI and reconfigure your provider via `/connect`, or set the provider API key env var. |
| Task hangs for several minutes | Open `altimate` (`altimate-code` on npm installs older than v0.7.1) to check for a pending prompt in the TUI, or re-run specifying a known-good model. |
| Empty result | The task may be too ambiguous — restate with the target table, expected columns, or time window. |
| `UNKNOWN_USER` / `Database does not exist` mid-run | The CLI connects but your warehouse credentials don't match this project — reconfigure warehouse auth in the `altimate` TUI (`altimate-code` on npm installs older than v0.7.1) or `profiles.yml`. |
| `Not signed in to Altimate` | Run `altimate auth login -p altimate-backend --method "Altimate LLM Gateway"` (`altimate-code` on npm installs older than v0.7.1). |
| Answers ignore your workspace's skills or knowledge | Run `altimate workspace status` in the project. If it isn't linked, ask Claude to link it, or run `altimate link` in a terminal. |
| Plugin installed but never delegates | Confirm it's enabled: `claude plugin enable altimate-code@altimate-claude-plugin`. |

Still stuck? See [Support](#support).

## Components

- **MCP server** — `.mcp.json` — direct stdio data tools
- **Analyst agent** — `agents/analyst.md` — read-only data analyst for the MCP tools
- **Routing skill** — `skills/altimate-code/SKILL.md` — direct questions or CLI delegation, workspace guidance
- **Review skill** — `skills/review/SKILL.md` — specialized dbt/SQL review
- **Commands** — `commands/altimate.md` (`/altimate-code:altimate`) and `commands/review.md`
- **Hook** — `hooks/hooks.json` and `hooks-handlers/session-start.sh`

## Support

- **Docs:** [docs.altimate.sh](https://docs.altimate.sh)
- **Issues:** [GitHub Issues](https://github.com/AltimateAI/altimate-claude-plugin/issues)
- **Community:** [Slack](https://altimate.studio/join-agentic-data-engineering-slack)
- **Email:** support@altimate.ai · security reports: security@altimate.ai

## License

MIT — see [LICENSE](../../LICENSE).
