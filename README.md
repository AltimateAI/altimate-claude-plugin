# Altimate Claude Plugin

The Altimate marketplace of Claude Code plugins.

Currently ships one plugin: **[altimate-code](./plugins/altimate-code/)** — gives Claude Code the data tools of [altimate-code](https://github.com/AltimateAI/altimate-code), with CLI delegation for long dbt and warehouse jobs.

The tools reach Claude in two ways:

- **MCP mode.** The plugin registers `altimate-code mcp serve` as a stdio MCP server. Claude Code does the reasoning and the server runs no LLM. This needs an altimate-code build that contains `mcp serve`, and the CLI on PATH as `altimate-code` (curl installs expose only `altimate`; npm and Homebrew expose both).
- **CLI mode.** When the MCP tools are not available in the session, because the organisation's managed settings disallow MCP servers, the server failed to start or the build lacks `mcp serve`, the same tools run through `altimate tool run`, which needs no MCP and no LLM either. Long jobs can still be delegated with `altimate run`, which uses the CLI's own LLM provider.

Source queries are read-only by default: database-enforced on Postgres, SQLite, and DuckDB; classification-only elsewhere, so use a read-only DB user. Connections come from project/global `.altimate-code/connections.json` and `ALTIMATE_CODE_CONN_*` environment variables. See the [plugin README](./plugins/altimate-code/README.md) for setup and details.

## Unpublished automatic pilot

A separate [altimate-code-experimental](plugins/altimate-code-experimental/) listing adds automatic data routing, first-use workspace setup and SQL results inside Claude Code. The pilot does not modify the default plugin. The pilot requires a platform-specific bundle with its compatible CLI; the Git source listing alone lacks that runtime. See [packaging, installation and verification limits](docs/workspace-data-mode.md). No default release or public pilot artifact is published by this draft.

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
