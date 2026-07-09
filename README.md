# Altimate Claude Plugin

The Altimate marketplace of Claude Code plugins.

Currently ships one plugin: **[altimate-code](./plugins/altimate-code/)** — delegates dbt and warehouse work to the [altimate-code](https://github.com/AltimateAI/altimate-code) CLI agent.

## Install

```
/plugin marketplace add AltimateAI/altimate-claude-plugin
/plugin install altimate-code@altimate-claude-plugin
```

The plugin ships with `defaultEnabled: false` — enable it explicitly:

```
claude plugin enable altimate-code@altimate-claude-plugin
```

See [plugins/altimate-code/README.md](./plugins/altimate-code/README.md) for plugin-specific docs (prerequisites, data-handling, components).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).
