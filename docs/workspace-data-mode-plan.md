# Workspace data mode

Extend the experimental plugin with an opt-in data mode. Claude remains the reasoning model; this work must not start `altimate run` or a second agent/model loop. Keep both product PRs draft.

## Behavior changes

1. `/altimate-mode on|off|status` opts the current conversation into routing data work through Altimate MCP. Ordinary prompts retain their text and attachments; a bounded context block describes the tools and current workspace. Mode starts off and resets on conversation end, resume, logout and `/clear`. Background notifications and subagent prompts are not rewritten.
2. `/altimate-workspace` shows the current workspace and available workspaces. Selecting an existing workspace uses the existing link operation, with memory backfill disabled for that command. No workspace creation, replacement of an existing link, shared-memory upload or installation happens automatically. A failed or unsupported CLI gives recovery instructions rather than delegating to a model.
3. An opt-in `mcp serve --workspace-tools` exposes workspace context, a named skill reader and the workspace engine's known read operations. The default five-tool server stays unchanged. The engine is pinned to the resolved workspace; account or binding changes invalidate its tools until restart. Knowledge queries use the existing engine's `ask_knowledge_base` capability, rather than a new knowledge implementation. Missing engine/authentication is reported independently of local SQL availability.
4. Workspace context uses existing account-scoped summaries, skills and memory hydration. Context has hard size bounds. Retrieved content is data, not authority to change tools or publish memory. Skills are fetched on demand rather than injected in bulk.
5. `/altimate-remember <id> <text>` is the explicit shared-memory action. It passes text as stdin to a new workspace CLI action; model tools cannot invoke this command through the mod. The CLI requires the expected workspace identity, saves one project memory using the existing store/sync path, and reports local persistence separately from cloud confirmation. No bulk sync is introduced.
6. The existing SQL pane and zero-model direct SQL command keep their permission, single-execution, error and lifecycle behavior. Workspace context appears in the data-mode status output; results stay in the existing pane.

## Repository split

Claude commands, prompt routing and display belong in `altimate-claude-plugin`, extending PR #9. Reusable workspace context/skill/memory operations and MCP adapters belong in an isolated `altimate-code` worktree, stacked on PR #1543 because its MCP server is required. No changes to the dirty main checkout or another owner's branch.

## Verification

- Event tests: opt-in only; prompt/attachment/origin preservation; no routing of notifications; lifecycle resets; late asynchronous completions cannot restore context from an old conversation; absent MCP/old CLI errors; model cannot publish memory; explicit command content stays data.
- Core tests: account/workspace changes refuse stale reads/calls/writes; invalid skill names and symlinks refused; context caps; missing/off/unlinked states; memory reports local/cloud results accurately; read engine allowlist excludes all mutations.
- Existing mod suite and strict root/plugin validation.
- Real Claude + synthetic SQLite smoke and natural-language routing/adoption measurement. Report accuracy, list-price cost, tokens, turns and wall time; do not claim a cost win from a warm-cache comparison.
- Live workspace verification only if authenticated disposable workspace access is available. No production binding or memory writes as a test. Missing live proof remains an explicit limitation.

## Cost and rollout

No new automatic model calls. Enabling data mode adds bounded context and one workspace read per user turn, so it can add latency and tokens; measure these. Explicit warehouse and knowledge queries retain their service costs. An explicit memory save uses the existing backend memory extraction/sync path, which may invoke a backend model; call that out in documentation. All behavior remains experimental and opt-in.
