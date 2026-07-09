# Contributing

Thanks for taking the time to contribute. This plugin lives in one repo (`AltimateAI/altimate-claude-plugin`) and ships a single Claude Code plugin (`altimate-code`) that delegates data-engineering tasks to the [altimate-code](https://github.com/AltimateAI/altimate-code) CLI.

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
│       ├── skills/
│       │   └── altimate-code/
│       │       └── SKILL.md     # delegation logic
│       ├── hooks/
│       │   └── hooks.json       # SessionStart hook config
│       ├── hooks-handlers/
│       │   └── session-start.sh # SessionStart hook handler
│       ├── commands/
│       │   └── altimate.md      # /altimate slash command
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
- **Explicit-invocation UX** (what `/altimate <task>` does): edit `plugins/altimate-code/commands/altimate.md`.
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

- **Skill** — `plugins/altimate-code/skills/altimate-code/SKILL.md` — the delegation logic (`altimate-code run "$USER_TASK"` and surface the result).
- **Hook** — `plugins/altimate-code/hooks/hooks.json` + `plugins/altimate-code/hooks-handlers/session-start.sh` — SessionStart hook that describes the plugin's capabilities in the system prompt so Claude can route to it when the task shape fits.
- **Command** — `plugins/altimate-code/commands/altimate.md` — `/altimate` slash command for explicit delegation with agent-persona selection.

## Reporting bugs / requesting features

Please open a GitHub issue on this repo. For security-sensitive reports, see [SECURITY.md](./SECURITY.md).
