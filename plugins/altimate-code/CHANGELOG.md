# Changelog

All notable changes to this plugin will be documented in this file.

## [1.0.1] — 2026-10-15

### Fixed
- The skills and slash commands now resolve the CLI as `altimate-code` and fall back to `altimate`. Standalone installs (curl, Homebrew, PowerShell) expose only `altimate`, so the plugin previously reported "not installed" on machines where the CLI was present.
- Install guidance and recovery messages now name `altimate`, which both install methods provide.

## [1.0.0] — 2026-07-09

### Added
- Initial release of the `altimate-code` plugin.
- Delegation skill (`skills/altimate-code/SKILL.md`) that routes dbt and warehouse tasks to the [altimate-code](https://github.com/AltimateAI/altimate-code) CLI agent instead of Claude's native tools.
- SessionStart hook (`hooks/hooks.json`) that describes the plugin's capabilities in the system prompt so Claude can route to it when the task shape fits.
- `/altimate` slash command (`commands/altimate.md`) for explicit delegation with agent-persona selection (`fast-edit` / `analyst` / `builder`).
