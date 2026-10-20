# Altimate Code — Claude Code plugin

Use [altimate-code](https://github.com/AltimateAI/altimate-code) data tools directly
from Claude Code through MCP. **Claude Code does the reasoning and carries the
LLM cost** for data questions; the stdio MCP server runs no LLM. Long multi-step
jobs such as dbt project builds, migrations, and FinOps reports can still be
delegated to `altimate-code run`, which uses its own agent and configured provider.

**1.1.0-experimental: direct MCP use requires an altimate-code build with `mcp serve`.**
This server is in an unreleased branch. Released builds without `mcp serve` fail
to start the MCP server; the plugin falls back to `altimate-code run` with the
analyst persona for data questions. It tells you which path is being used.

## Install

```
/plugin marketplace add AltimateAI/altimate-claude-plugin
/plugin install altimate-code@altimate-claude-plugin
```

## Prerequisites

Put `altimate-code` on PATH where Claude Code can launch it. The CLI requires
Node 20+. For direct MCP use, install a build containing `mcp serve`. Check your
build with `altimate-code mcp serve --help`; an unknown command means the MCP
server cannot start and data questions use CLI delegation instead. Installing
the latest published npm package alone does not provide the unreleased server.

Configure database connections as described below. Direct MCP use does **not**
require an altimate-code LLM provider or API key. For delegated jobs only, run
`altimate-code` to configure its provider (or use its provider environment settings).

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

The routing skill and `/altimate <task>` prefer this direct
path for answers, numbers, and lists when the MCP tools are available in the
session. If the server is missing or fails to start, they delegate data questions
with `--agent analyst`. Long jobs and capabilities outside the five MCP tools use
`altimate-code run` with persona selection (`fast-edit`, `analyst`, or `builder`)
and a private output file. The plugin tells you which path it uses.
Delegated jobs use the CLI's separate LLM provider,
costs, and rate limits. `/review` retains the specialized dbt/SQL reviewer.
A short SessionStart hook describes these capabilities to Claude.

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

## Example prompts

- "How many orders were completed last month? Return the count and total revenue."
- "Join customer activity across our two connections and list the ten most active customers."
- "/altimate Build and test a dbt staging project for these sources."
- "/altimate Produce a warehouse FinOps report with recommendations."
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
| `command not found: altimate-code` | Install altimate-code on Claude Code's PATH for delegation; direct MCP tools additionally require a build with `mcp serve`. |
| Unknown `mcp` or `serve` command | The MCP server fails to start; data questions fall back to CLI analyst delegation. Configure the CLI's LLM provider for delegation, or use a build containing `mcp serve` for direct MCP tools. |
| No connections / database access error | Check project/global connection files, `ALTIMATE_CODE_CONN_*` environment variables, and database permissions. |
| `Unauthorized` / `No provider configured` from a delegated job | Configure the CLI's LLM provider; direct MCP data questions do not need it. |
| Delegated job hangs or returns no output | Check the CLI TUI for pending prompts and provide a precise target and expected result. |
| Plugin unavailable | Confirm it is enabled: `claude plugin enable altimate-code@altimate-claude-plugin`. |

## Components

- **MCP server** — `.mcp.json` — direct stdio data tools
- **Routing skill** — `skills/altimate-code/SKILL.md` — direct questions or CLI delegation
- **Review skill** — `skills/review/SKILL.md` — specialized dbt/SQL review
- **Commands** — `commands/altimate.md` and `commands/review.md`
- **Hook** — `hooks/hooks.json` and `hooks-handlers/session-start.sh`

## Support

- **Docs:** [docs.altimate.sh](https://docs.altimate.sh)
- **Issues:** [GitHub Issues](https://github.com/AltimateAI/altimate-claude-plugin/issues)
- **Community:** [Slack](https://altimate.studio/join-agentic-data-engineering-slack)
- **Email:** support@altimate.ai · security reports: security@altimate.ai

## License

MIT — see [LICENSE](../../LICENSE).
