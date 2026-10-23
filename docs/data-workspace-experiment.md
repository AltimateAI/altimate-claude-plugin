> Historical manual-prototype notes. The current implementation is the separate automatic experimental listing; see [current behavior and rollout](workspace-data-mode.md). Paths to the original plugin below describe the earlier prototype, not the preserved main listing.

# Claude Code data workspace experiment

2026-10-22. Draft, stacked on the direct MCP integration experiment. No rollout or merge recommendation yet.

The mod adds a user-opened results pane and an executable SQL command. Claude still reasons over Altimate's existing MCP tools for natural-language tasks. The mod observes the original tool execution once and preserves its result; it adds no model requests, tools, prompt rewrites, filesystem writes, network requests, shell processes, or automatic warehouse queries. Existing SQL execution safety checks and result linting remain in the server.

## Acceptance and scope

- Natural-language query: no pane → `/altimate-data` opens a pane showing the existing query, connection, result and backend findings.
- Known SQL: Markdown handoff/model turn → `/altimate-query <connection> <SQL>` executes the MCP tool directly with normal Claude Code permissions, then returns its text.
- Missing MCP: direct command reports recovery and runs no query; existing routing/delegation behavior remains available separately.
- Source mutation: default server refuses it; the mod never approves or retries it.
- No mod: existing MCP tools continue to work. No new tools or automatic queries are required for the pane.
- History: latest eight calls, in-memory previews only, cleared by `/clear`, clear button, conversation end (including resume/logout), session start or module reload. Closing the pane hides it. These limits do not change model-visible results or normal transcript retention.

This does not migrate Altimate workspace memory/skills into Claude, provide a connection picker, implement another agent loop, or replace backend authorization. It supports the plugin's existing scoped `sql_execute` tool name, not arbitrary MCP servers with a similarly named tool.

## Measurements

Claude Code 2.1.307, Sonnet 5.5 (`claude-sonnet-5-5` as reported by the CLI), medium effort, three trials each of two questions. All arms received the same prompt and used a synthetic local SQLite table of 60 orders. Plain Claude had Bash/Read and could query with a local client. MCP and mod arms also had the same five Altimate tools and plugin instructions. MCP-only differs from mod by the `modules` entry in a copied hooks manifest. The server was the unreleased `mcp serve` implementation at `6dd2f27cba1d7dfbbab26fa89507521d49338f4a`, run from source with Bun, local integrations and an explicit connections file.

| Arm | Correct | Runs using Altimate tools | Mean list-price $/run | Mean input tokens including cache reads/writes | Mean model requests | Median end-to-end seconds |
|---|---:|---:|---:|---:|---:|---:|
| Plain Claude | 6/6 | 0/6 | 0.01214 | 30,698 | 2 | 5.384 |
| MCP only | 6/6 | 6/6 | 0.01491 | 50,258 | 3 | 6.803 |
| MCP plus mod | 6/6 | 6/6 | 0.01531 | 50,913 | 3 | 5.826 |

Input-token breakdown (mean fresh/cache-read/cache-write): plain 4 / 28,751 / 1,944; MCP 6 / 48,362 / 1,889; mod 6 / 48,941 / 1,965. Dollars are the CLI's reported list-price `total_cost_usd`, not an additional invoice on a subscription. `num_turns` counts model requests in these runs, not six separate user conversations per task. Wall time includes process/MCP startup. Each trial used a fresh session. Arms ran with at most three concurrent processes, in rotated submission order, sharing the provider's prompt cache. Costs and latency are cache-sensitive; this is a small feasibility comparison, not a statistically powered benchmark.

For the explicit SQL command, the paid-order aggregate returned `40 | 12000` in 3.051 seconds end-to-end, with zero input/output tokens, zero model requests and $0 model cost. This is **not** an apples-to-apples natural-language accuracy comparison: the human supplied SQL. It demonstrates the executable workflow opportunity. It still incurs any database query costs; this fixture was local SQLite.

The same command's attempted `DELETE` was refused with `Permission denied: sql_execute_write`; an independent SQLite read confirmed all 60 rows remained. A missing-server test returned `No query was run` without delegation. Headless commands ran through real Claude Code and the real MCP server, not API stubs.

In a real Claude Code 2.1.307 terminal session, `/altimate-query` returned the paid-order totals, `/altimate-data` opened the pane with the connection, SQL and `40 | 12000`, Escape closed it, and `/clear` followed by reopening the pane showed the empty-state instructions. The terminal ran with the Team-plan built-in guard and normal tool permissions. Desktop and VS Code element trees were checked with the test kit; their actual painting was not observed. An early lifecycle implementation using `classic.SessionStart` was skipped by that guard; the final mod clears on `command.run` for `/clear` and on `session.end`, which also covers resuming another conversation.

## Interpretation

The results do not show a reasoning-cost win from the mod. Both MCP arms needed three model requests versus two for plain Claude. The mod was about 2.7% more expensive than MCP-only in this sample, which is too small and cache-sensitive to establish a regression or improvement. Natural-language accuracy was at ceiling. The mod's lower observed median latency is not enough evidence of a speed improvement.

The useful new behavior is direct SQL execution without a model request and a native place to inspect results. Keep the draft for usability testing; do not replace the integration architecture or market cost/accuracy gains on these results. The next evaluation should use realistic multi-step warehouse work and human tasks such as finding a previous query/result, alongside model and warehouse cost measurements.

## Reproduce

Run `claude plugin test ./plugins/altimate-code`, then strict validation of both the repository and plugin. The offline tests stub tools; they cover transparent forwarding, one execution, permissions/errors, preview bounds, unrelated tools/panes, clearing while a query is running, and terminal/Desktop/VS Code element trees. These tests do not verify the apps' painting or a real permission dialog.

`python3 tests/mod-smoke.py --claude-bin /absolute/path/to/claude --server-command '["altimate-code","mcp","serve"]' --trials 3 --output /tmp/mod-results.json` performs the synthetic workflow and comparison. `--smoke-only` runs direct commands without model requests. `--server-command` accepts a JSON argv array so a source invocation can be substituted without a shell. The CLI must contain `mcp serve`; released builds without it cannot run this test.

The harness isolates ordinary settings and ambient MCPs. It explicitly registers the plugin's scoped server because `--strict-mcp-config` excludes plugin registrations too. It never uses real warehouse credentials. Raw result JSON stays at the output path you choose; the disposable fixture and copied plugins are deleted afterwards.
