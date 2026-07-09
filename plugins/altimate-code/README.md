# Altimate Code — Claude Code plugin

Routes dbt + warehouse tasks through [altimate-code](https://github.com/AltimateAI/altimate-code), a specialized CLI agent with purpose-built data-engineering tools (column-level lineage, dbt build/test/run against real warehouses, FinOps, cross-DB migration, PII detection, and more).

## Install

```
/plugin marketplace add AltimateAI/altimate-claude-plugin
/plugin install altimate-code@altimate-claude-plugin
```

The plugin ships with `defaultEnabled: false` — enable it explicitly when you want warehouse work delegated to altimate-code:

```
claude plugin enable altimate-code@altimate-claude-plugin
```

## Prerequisites

The altimate-code CLI must be installed and configured on your PATH before this plugin can invoke it:

```
npm install -g @altimateai/altimate-code
altimate-code providers login
```

If altimate-code is not on PATH, the skill surfaces the failure to the user rather than falling back to native tools.

## Data handling

This plugin **forwards the user's task prompt** to the altimate-code CLI, which in turn dispatches to Altimate's LLM gateway (or to the user-configured provider). Concretely:

- The full task text you send Claude Code, verbatim, is passed to `altimate-code run` when the skill fires.
- altimate-code then contacts a third-party LLM (default: Altimate gateway; user-configurable) to plan and execute the work.
- Warehouse queries, dbt commands, and file edits performed by altimate-code happen locally under your credentials; results are returned to Claude Code and shown to you.

If you don't want prompts to leave Claude Code's process, disable this plugin.

## Components

- **Skill** — `skills/altimate-code/SKILL.md` — the delegation logic
- **Hook** — `hooks/hooks.json` — SessionStart hook that reminds the assistant when the skill is available
- **Command** — `commands/altimate.md` — `/altimate` slash command

## License

MIT — see `LICENSE`.
