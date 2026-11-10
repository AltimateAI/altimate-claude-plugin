# Altimate Claude Plugin

The Altimate marketplace of Claude Code plugins.

Currently ships one plugin: **[altimate-code](./plugins/altimate-code/)** — gives Claude Code the data tools of [altimate-code](https://github.com/AltimateAI/altimate-code), with CLI delegation for long dbt and warehouse jobs.

The tools reach Claude in two ways:

- **MCP mode.** The plugin registers `altimate-code mcp serve` as a stdio MCP server. Claude Code does the reasoning and the server runs no LLM of its own; workspace knowledge questions are answered by Altimate's backend models. This needs an altimate-code build that contains `mcp serve`, and the CLI on PATH as `altimate-code` (npm, Homebrew and current curl and PowerShell installs expose both; curl and PowerShell installs older than v0.12.8 expose only `altimate`).
- **CLI mode.** When the MCP tools are not available in the session, because the organisation's managed settings disallow MCP servers, the server failed to start or the build lacks `mcp serve`, the same tools run through `altimate tool run`, which needs no MCP and runs no LLM of its own either (workspace knowledge questions are answered by Altimate's backend models, as in MCP mode). Long jobs can still be delegated with `altimate run`, which uses the CLI's own LLM provider.

Source queries are read-only by default: database-enforced on Postgres, SQLite, and DuckDB; classification-only elsewhere, so use a read-only DB user. Connections come from project/global `.altimate-code/connections.json` and `ALTIMATE_CODE_CONN_*` environment variables. See the [plugin README](./plugins/altimate-code/README.md) for setup and details.

## Install

```bash
claude plugin install altimate-code --marketplace AltimateAI/altimate-claude-plugin
```

See [plugins/altimate-code/README.md](./plugins/altimate-code/README.md) for plugin-specific docs (prerequisites, data-handling, components).

## Update

```bash
claude plugin marketplace update altimate-claude-plugin
claude plugin update altimate-code@altimate-claude-plugin
```

Then restart Claude Code.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License & legal

MIT — see [LICENSE](./LICENSE).
Privacy: [PRIVACY.md](./PRIVACY.md) · Terms: [TERMS.md](./TERMS.md) · Security: [SECURITY.md](./SECURITY.md)
