# Altimate Code — Claude Code plugin

Routes dbt + warehouse tasks from Claude Code to [altimate-code](https://github.com/AltimateAI/altimate-code), a specialized open-source CLI agent with 100+ deterministic data-engineering tools: SQL anti-pattern detection, column-level lineage, dbt build/test/run against real warehouses, FinOps and cost analysis, cross-dialect translation and data parity, and PII detection.

**Why delegate?** General coding agents can edit SQL files; they can't inspect your live warehouse state. altimate-code gives Claude Code a deterministic data-engineering layer — indexed schemas, real query history, real cost data — instead of guesses.

## Install

```
/plugin marketplace add AltimateAI/altimate-claude-plugin
/plugin install altimate-code@altimate-claude-plugin
```

## Prerequisites

The altimate-code CLI must be installed and configured on your PATH:

```bash
npm install -g altimate-code     # requires Node 20+
altimate-code                    # launch the TUI, then run /connect to configure your LLM provider
```

Or configure a provider via environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and 20+ others — see the [altimate-code docs](https://docs.altimate.sh)).

If altimate-code is not on PATH or not configured, the plugin surfaces the failure with fix instructions rather than silently falling back to Claude's native tools.

## How it works

1. A **SessionStart hook** adds a static description of altimate-code's capabilities to the session, so Claude Code knows when a task fits.
2. When a data-engineering task fires the **skill** (or you invoke **`/altimate <task>`** explicitly), Claude Code runs `altimate-code run "<your task>"` locally, selecting the cheapest suitable agent persona (`fast-edit` for dbt/SQL edits, `analyst` for aggregation-heavy correctness work, `builder` for warehouse-state investigation).
3. altimate-code plans and executes the task using your configured LLM provider. Warehouse queries, dbt commands, and file edits run **locally under your credentials**.
4. The result is written to a local output file and surfaced back in your Claude Code conversation.

## Example prompts

Once installed, try these in Claude Code (or prefix any of them with `/altimate`):

1. **Column-level lineage** — *"Trace the `revenue_usd` column in `models/marts/fct_revenue.sql` back to its sources, and list every downstream model that would be affected if I change its rounding."*
2. **Warehouse cost analysis** — *"Give me a cost report for our Snowflake account: the ten most expensive queries this month and any warehouses that look over-provisioned."*
3. **Cross-dialect validation** — *"Compare `prod.orders` in Snowflake with `analytics.orders` in BigQuery row-by-row using `id` as the key, and summarize any mismatches."*
4. **dbt test generation** — *"Generate dbt tests for `models/staging/stg_orders.sql`, including unit tests for the CASE/WHEN logic."*

## Data handling

Delegating a task passes your prompt text to the altimate-code CLI, which sends it to your configured LLM provider — the Altimate LLM Gateway by default, or your own provider (BYOK), in which case Altimate never sees it. Warehouse credentials and query results stay on your machine.

Full details: **[PRIVACY.md](../../PRIVACY.md)** · Security policy and disclosure: **[SECURITY.md](../../SECURITY.md)** · Terms: **[TERMS.md](../../TERMS.md)**

## Troubleshooting

| Symptom | Fix |
|---|---|
| `command not found: altimate-code` | `npm install -g altimate-code` (Node 20+), then run `altimate-code` once to configure your provider. |
| `Unauthorized` / `No provider configured` | Run `altimate-code` to open the TUI and reconfigure your provider via `/connect`, or set the provider API key env var. |
| Task hangs for several minutes | Open `altimate-code` to check for a pending prompt in the TUI, or re-run specifying a known-good model. |
| Empty result | The task may be too ambiguous — restate with the target table, expected columns, or time window. |
| `UNKNOWN_USER` / `Database does not exist` mid-run | The CLI connects but your warehouse credentials don't match this project — reconfigure warehouse auth in the `altimate-code` TUI or `profiles.yml`. |
| Plugin installed but never delegates | Confirm it's enabled: `claude plugin enable altimate-code@altimate-claude-plugin`. |

Still stuck? See [Support](#support).

## Components

- **Skill** — `skills/altimate-code/SKILL.md` — delegation logic and agent-persona selection
- **Command** — `commands/altimate.md` — `/altimate` slash command for explicit delegation
- **Hook** — `hooks/hooks.json` — SessionStart capability description (static text only)

## Support

- **Docs:** [docs.altimate.sh](https://docs.altimate.sh)
- **Issues:** [GitHub Issues](https://github.com/AltimateAI/altimate-claude-plugin/issues)
- **Community:** [Slack](https://altimate.studio/join-agentic-data-engineering-slack)
- **Email:** support@altimate.ai · security reports: security@altimate.ai

## License

MIT — see [LICENSE](../../LICENSE).
