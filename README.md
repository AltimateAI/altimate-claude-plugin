# Altimate Claude Plugin

The Altimate marketplace of Claude Code plugins.

Currently ships one plugin: **[altimate-code](./plugins/altimate-code/)** — delegates dbt and warehouse work to the [altimate-code](https://github.com/AltimateAI/altimate-code) CLI agent.

## Unpublished automatic pilot

A separate [altimate-code-experimental](plugins/altimate-code-experimental/) listing adds automatic data routing, first-use workspace setup and SQL results inside Claude Code. The original plugin and its marketplace entry remain unchanged from main. The pilot requires a platform-specific bundle with its compatible CLI; the Git source listing alone lacks that runtime. See [packaging, installation and verification limits](docs/workspace-data-mode.md). No default release or public pilot artifact is published by this draft.

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
