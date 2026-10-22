# Workspace-aware data mode (experimental)

The mod lives in this plugin; reusable workspace operations live in Altimate Code. Requires the workspace-enabled MCP build stacked on AltimateAI/altimate-code#1543 and Claude Code 2.1.307. Keep this experiment in draft.

## Try it

1. Sign in to Altimate Code for the intended deployment. The plugin uses the CLI's saved credentials, never its own copy.
2. Start Claude with this plugin. Its MCP registration now uses `mcp serve --workspace-tools`. Builds without that flag need updating; the mod never silently starts a separately billed reasoning agent.
3. Run `/altimate-workspace` to inspect the linked workspace and choose an existing workspace. Selection can link an unlinked project. To replace a link, use `altimate-code link` in the terminal. Reconnect Altimate through `/mcp` after linking. Selection disables automatic memory backfill; it never creates a workspace or installs anything.
4. Run `/altimate-mode on`. Data questions receive bounded workspace context and guidance to use Altimate MCP directly, with Claude reasoning. `/altimate-mode off` restores ordinary prompt handling. Mode starts off and resets on `/clear`, conversation end, resume and logout.
5. Use `/altimate-data` for recent SQL results or `/altimate-query <connection> <SQL>` for a zero-model SQL command. Workspace tools have the `workspace_` prefix. Knowledge uses `workspace_ask_knowledge_base` when the existing engine provides it; skills load individually through `workspace_skill`.
6. To save a decision, inspect `/altimate-workspace` first, then type `/altimate-remember <id> <text>`. Text is limited to 2,048 characters. This writes one project memory and attempts workspace publication through the existing sync path. The response distinguishes confirmed publication from a local save with uncertain publication. Interrupted saves are never automatically retried.

The workspace engine must be installed and current. Its connection is pinned to the startup workspace; changing account or binding refuses stale calls until reconnect. The facade exposes a fixed set of known read operations. SQL uses Altimate's existing read-only classifier; use read-only warehouse credentials because classification cannot guarantee that stored functions have no side effects. The default server without `--workspace-tools` keeps its original five tools.

The mod runs the CLI with argument arrays; memory text goes over stdin. It never starts `altimate run` or another reasoning agent. Only user-originated `/altimate-remember` commands invoke saving through the mod. This is a workflow control, not filesystem isolation from a model that already has shell access. Retrieved content cannot authorize saving. Picker state and previews stay in memory; normal transcripts, Altimate memory files and MCP spills retain their normal retention rules.

## Verification and measured limits

Plugin tests cover events and UI trees; core tests cover identities/credentials, bounded context, named skills, explicit saving and an actual stdio connection to a local protocol fixture. Existing local SQL MCP tests remain applicable. A production read listed 17 visible workspaces and loaded context for a matching selected workspace through a temporary local project. No production project was linked and no production memory was written. The temporary project returned zero memory blocks; that does not prove non-empty production memory delivery or a write round trip. Real workspace-engine queries and Desktop/VS Code painting remain rollout checks.

A six-run local smoke used Claude Code 2.1.307, Sonnet 5.5, medium effort, synthetic SQLite orders, one trial each of two questions. Data mode was explicitly enabled through streamed SDK input before each mod-arm question. Plain/MCP/mod all answered 2/2 correctly; both MCP arms used Altimate tools in 2/2 runs, measured from assistant tool-call parts.

| Arm | Mean list-price $/run | Mean input tokens, including cache | Mean model requests | Median wall seconds |
| --- | ---: | ---: | ---: | ---: |
| Plain Claude | 0.02691 | 30,696.5 | 2 | 6.083 |
| MCP only | 0.03265 | 50,465 | 3 | 6.877 |
| Mod, data mode on | 0.03349 | 51,979 | 3 | 6.541 |

This sample is too small and cache-sensitive to establish latency or cost improvements. Mode adds context and a workspace-context read per user turn. The workspace was unavailable in this isolated SQL comparison, so it measured fallback overhead, not workspace knowledge value. The direct aggregate command returned the correct result with zero model turns/tokens and $0 model cost, taking 2.373 seconds including process/MCP startup. Source mutation was refused; missing MCP produced no query. Prior SQL-pane comparisons remain in [the original report](data-workspace-experiment.md) and describe the earlier implementation.

A separate real-Claude routing trial used a synthetic workspace MCP fixture. Asking for the workspace's revenue convention read `workspace_context`, called `workspace_ask_knowledge_base`, and returned the fixture's booked-ARR policy, excluding professional services. Assistant tool parts showed ToolSearch and the knowledge MCP call, with no Bash/Agent delegation. This validates native routing through the revised plugin guidance, not production knowledge retrieval. Mode changes accept direct terminal, bridge or SDK requests; another plugin cannot toggle mode.

Reproduce with `python3 tests/mod-smoke.py --claude-bin /absolute/path/to/claude --server-command '["altimate-code","mcp","serve","--workspace-tools"]' --trials 1 --data-mode --workspace-routing --output /tmp/data-mode-results.json`. Model runs consume Claude plan/API usage. This is a usability and distribution experiment, not evidence for a reasoning-cost marketing claim.

No automatic model call is added by the mod. Explicit knowledge queries may use the engine's backend models; explicit memory publication uses the existing backend extraction path and can incur backend model cost. Warehouse queries retain their costs. Context is bounded, skills load on demand, and no per-row model loop or bulk memory sync is introduced.
