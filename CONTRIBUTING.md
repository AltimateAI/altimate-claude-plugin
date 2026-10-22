# Contributing

Thanks for taking the time to contribute. This plugin lives in one repo (`AltimateAI/altimate-claude-plugin`) and ships a single Claude Code plugin (`altimate-code`). It prefers direct MCP tools for data questions and delegates to the [altimate-code](https://github.com/AltimateAI/altimate-code) CLI for other capabilities and long jobs. When MCP tools are unavailable, data questions also delegate, using the analyst persona. Both paths tell the user which is being used; delegation uses the CLI's separate configured LLM provider.

## Quick start

1. Fork this repo and clone your fork.
2. Make your change in a topic branch off `main`.
3. Validate BOTH the marketplace and the plugin:
   ```bash
   # Validate marketplace manifest (repo root)
   claude plugin validate --strict .
   # Validate the plugin (descends into skills, catches frontmatter errors)
   claude plugin validate --strict ./plugins/altimate-code
   ```
   Both must exit clean. **Validating the repo root alone is not sufficient** — the marketplace-level validator does not descend into skills, so skill-frontmatter parse errors go undetected unless you also validate the plugin path.

   If you touch the CLI resolver block in a skill or command, run `./tests/resolve-cli.sh` — it checks every copy is identical and resolves correctly in bash and zsh.
4. Open a PR against `AltimateAI/altimate-claude-plugin:main`.

## Repo layout

```
altimate-claude-plugin/
├── .claude-plugin/
│   └── marketplace.json     # marketplace descriptor (source: ./plugins/altimate-code)
├── plugins/
│   └── altimate-code/
│       ├── .claude-plugin/
│       │   └── plugin.json      # plugin manifest
│       ├── .mcp.json             # local stdio MCP server registration
│       ├── skills/
│       │   └── altimate-code/
│       │       └── SKILL.md     # MCP/delegation routing and CLI invocation
│       ├── agents/
│       │   └── analyst.md       # read-only data analyst for the MCP tools
│       ├── hooks/
│       │   └── hooks.json       # SessionStart hook config
│       ├── hooks-handlers/
│       │   └── session-start.sh # SessionStart hook handler
│       ├── commands/
│       │   └── altimate.md      # /altimate-code:altimate slash command
│       ├── README.md            # plugin-specific docs
│       └── CHANGELOG.md         # plugin-specific changelog
├── README.md                # repo overview
├── SECURITY.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
└── LICENSE
```

## What to change where

- **Routing behavior** (when Claude picks up the skill): edit `plugins/altimate-code/skills/altimate-code/SKILL.md` frontmatter description and/or `plugins/altimate-code/hooks-handlers/session-start.sh` `additionalContext`.
- **Direct data-question analysis**: edit `plugins/altimate-code/agents/analyst.md` (the server instructions carry the method).
- **MCP server launch**: edit `plugins/altimate-code/.mcp.json` (`altimate-code mcp serve`, read-only by default).
- **Explicit-invocation UX** (what `/altimate-code:altimate <task>` does): edit `plugins/altimate-code/commands/altimate.md`.
- **CLI invocation details** (agent selection, flags, follow-up handling): edit the workflow section in `plugins/altimate-code/skills/altimate-code/SKILL.md`.

## Frontmatter — YAML gotcha

The `description:` field in `SKILL.md` is loaded as YAML frontmatter. If your description contains literal double quotes, wrap the value in a YAML folded block scalar (`>-`) so the parser doesn't trip on the embedded quotes:

```yaml
---
name: altimate-code
description: >-
  Delegates ... "altimate" ...
---
```

`claude plugin validate --strict .` will catch a broken frontmatter with an explicit error before you push.

## Testing changes

The experimental SQL mod lives in `plugins/altimate-code/hooks/data-workspace.mjs`.
Run its event and UI tests with `claude plugin test ./plugins/altimate-code`.
Use Claude Code 2.1.307 for the tested API. `claude plugin validate --strict` statically
lists the mod's events and calls; it does not prove the UI or warehouse workflow works.
The mod adds no SQL engine; safety checks and linting stay in altimate-code.

For a real local SQLite smoke and optional three-arm comparison, run
`python3 tests/mod-smoke.py --claude-bin /absolute/path/to/claude --server-command '["altimate-code","mcp","serve"]' --output /tmp/mod-results.json`.
Pass `--smoke-only` to skip model runs. The comparison uses existing Claude credentials
and consumes model usage. It creates only synthetic local data, ignores ordinary
user/project settings, and uses strict MCP configuration to exclude ambient servers.
Pin the tested Claude executable: another installed version may lack mods.

Manually:

```bash
# From the repo root, install the plugin as a local marketplace source
claude plugin marketplace add --source-type local .
claude plugin install altimate-code@altimate-claude-plugin
# Use claude to smoke the routing you changed
```

## Components

- **Routing skill** — `plugins/altimate-code/skills/altimate-code/SKILL.md` — prefer available MCP tools for data questions; otherwise delegate to `altimate-code run` with `analyst`. Delegate other capabilities and long jobs using the appropriate persona.
- **Analyst agent** — `plugins/altimate-code/agents/analyst.md` — read-only data analyst rules for the MCP tools.
- **MCP registration** — `plugins/altimate-code/.mcp.json` — launches the local stdio server; builds without `mcp serve` fail to start it and use delegation instead.
- **Hook** — `plugins/altimate-code/hooks/hooks.json` + `plugins/altimate-code/hooks-handlers/session-start.sh` — SessionStart hook that describes the plugin's capabilities in the system prompt so Claude can route to it when the task shape fits.
- **Command** — `plugins/altimate-code/commands/altimate.md` — `/altimate-code:altimate` slash command follows the same MCP/delegation routing with agent-persona selection.

## Reporting bugs / requesting features

Please open a GitHub issue on this repo. For security-sensitive reports, see [SECURITY.md](./SECURITY.md).
