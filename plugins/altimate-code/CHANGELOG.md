# Changelog

All notable changes to this plugin will be documented in this file.

## [1.1.0] — 2026-10-19

### Fixed
- Delegated runs no longer hang. Claude Code's shell leaves stdin open and `altimate-code run` reads piped stdin as part of the task, so the run waited forever before it started. Every `altimate-code run` invocation now redirects stdin from `/dev/null`.
- The skill and `/altimate-code:altimate` no longer pass `--agent fast-edit`. altimate-code has no such agent, so every run fell back to `builder` with a warning. Runs now ask for `builder` directly.
- Sign-in advice uses `altimate-code auth login -p altimate-backend --method "Altimate LLM Gateway"`. Without `--method`, `auth login` waits at a menu that Claude Code's `!` prompt cannot answer.
- The output file is created with `mktemp "${TMPDIR:-/tmp}/altimate-result.XXXXXX"`. On macOS, `mktemp -t altimate-result.XXXXXX.md` left the `X`s in the name.

### Added
- Altimate workspaces: the skill, `/altimate-code:altimate` and the SessionStart context say that a linked project's runs use the workspace's skills, knowledge and memory, route questions about the team's own conventions and knowledge to altimate-code, and tell the user how to sign in and link. Linking from Claude Code lists the workspaces with `altimate-code workspace list` (in altimate-code releases that have it) and links the chosen one with `link --workspace`, because the `link` picker needs a terminal that `!` does not provide.
- README: "Use an Altimate workspace" setup, and the install command for Anthropic's plugin directory.

### Changed
- Docs name the command `/altimate-code:altimate`, as Claude Code lists it. Claude Code namespaces plugin commands, so a bare `/altimate` answers "Unknown command".

## [1.0.0] — 2026-07-09

### Added
- Initial release of the `altimate-code` plugin.
- Delegation skill (`skills/altimate-code/SKILL.md`) that routes dbt and warehouse tasks to the [altimate-code](https://github.com/AltimateAI/altimate-code) CLI agent instead of Claude's native tools.
- SessionStart hook (`hooks/hooks.json`) that describes the plugin's capabilities in the system prompt so Claude can route to it when the task shape fits.
- `/altimate` slash command (`commands/altimate.md`) for explicit delegation with agent-persona selection (`fast-edit` / `analyst` / `builder`).
