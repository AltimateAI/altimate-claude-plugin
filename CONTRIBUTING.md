# Contributing

Thanks for taking the time to contribute. This plugin lives in one repo (`AltimateAI/altimate-claude-plugin`) and ships a single Claude Code plugin (`altimate-code`). It uses the [altimate-code](https://github.com/AltimateAI/altimate-code) data tools through MCP when the session has them, and through the model-free `altimate tool run` CLI when it does not (for example when an organisation disallows MCP servers). Long jobs are delegated to the CLI agent, which uses the CLI's separate configured LLM provider.

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
│       │   └── hooks.json       # SessionStart, Stop and PreToolUse hook config
│       ├── hooks-handlers/
│       │   ├── session-start.sh # SessionStart: capability text, mode, skill copy
│       │   ├── data-mode.sh     # MCP or CLI mode, from PATH and MCP settings
│       │   ├── sync-workspace-skills.py # copies workspace skills into .claude/skills
│       │   ├── refresh-skills.sh # background / on-demand workspace skill refresh
│       │   └── warehouse-guard.sh # opt-in PreToolUse warehouse-client guard
│       ├── commands/
│       │   ├── altimate.md      # /altimate-code:altimate slash command
│       │   └── refresh-skills.md # /altimate-code:refresh-skills
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

Manually:

```bash
# From the repo root, install the plugin as a local marketplace source
claude plugin marketplace add --source-type local .
claude plugin install altimate-code@altimate-claude-plugin
# Use claude to smoke the routing you changed
```

## Components

- **Routing skill** — `plugins/altimate-code/skills/altimate-code/SKILL.md` — use the MCP tools when available, otherwise `tool run` (after `tool context`); delegate long jobs with `run`.
- **Analyst agent** — `plugins/altimate-code/agents/analyst.md` — read-only data analyst that works in both modes.
- **MCP registration** — `plugins/altimate-code/.mcp.json` — launches the local stdio server; builds without `mcp serve` fail to start it and the CLI mode applies instead.
- **Hooks** — `plugins/altimate-code/hooks/hooks.json`:
  - SessionStart (`hooks-handlers/session-start.sh`) describes the plugin's capabilities so Claude can route to it, adds the CLI guidance when `data-mode.sh` picks the CLI mode, and copies the linked workspace's skills (`sync-workspace-skills.py`).
  - Stop (`refresh-skills.sh --if-stale`) refreshes those skills in the background at most hourly.
  - PreToolUse (`warehouse-guard.sh`) points direct warehouse clients at `tool run`, only with `ALTIMATE_ROUTE_GUARD=1`.
- **Tests** — `tests/*.sh` and `python3 -m pytest tests/`; run them all before a PR.
- **Command** — `plugins/altimate-code/commands/altimate.md` — `/altimate-code:altimate` slash command follows the same routing with agent-persona selection for delegation.

## Reporting bugs / requesting features

Please open a GitHub issue on this repo. For security-sensitive reports, see [SECURITY.md](./SECURITY.md).
