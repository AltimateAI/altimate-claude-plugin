# Altimate Claude Plugin

The Altimate marketplace of Claude Code plugins.

Currently ships one plugin: **[altimate-code](./plugins/altimate-code/)** — gives Claude Code direct MCP data tools from [altimate-code](https://github.com/AltimateAI/altimate-code), with CLI delegation for long dbt and warehouse jobs.

**Experimental: direct MCP use requires an altimate-code build with `mcp serve`.**
Released builds without `mcp serve` fail to start the MCP server; the plugin then
falls back to `altimate-code run` with the analyst persona for data questions,
using the CLI's configured LLM provider. The plugin tells you which path it uses.
With MCP available, Claude Code
supplies the reasoning and LLM cost for direct data questions; the MCP server
runs no LLM. Tools: `warehouse_list`, `warehouse_add`, `sql_execute` (with `tables`
for schemas and value profiles), `sql_materialize` (session-local scratch DuckDB for
cross-database joins) and `answer_commit`.

Source queries are read-only by default: database-enforced on Postgres, SQLite,
and DuckDB; classification-only elsewhere, so use a read-only DB user. Connections
come from project/global `.altimate-code/connections.json` and
`ALTIMATE_CODE_CONN_*` environment variables, or an explicit `--connections <file>`
server argument. See the [plugin README](./plugins/altimate-code/README.md) for setup,
value profiles, result spill files, and the separate LLM billing for delegated jobs.

## Install

From Anthropic's plugin directory:

```bash
claude plugin install altimate-code
```

Or from this marketplace:

```
/plugin marketplace add AltimateAI/altimate-claude-plugin
/plugin install altimate-code@altimate-claude-plugin
```

See [plugins/altimate-code/README.md](./plugins/altimate-code/README.md) for plugin-specific docs (prerequisites, data-handling, components).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License & legal

MIT — see [LICENSE](./LICENSE).
Privacy: [PRIVACY.md](./PRIVACY.md) · Terms: [TERMS.md](./TERMS.md) · Security: [SECURITY.md](./SECURITY.md)
