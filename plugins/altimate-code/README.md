# Altimate Code — Claude Code plugin

Routes dbt + warehouse tasks from Claude Code to [altimate-code](https://github.com/AltimateAI/altimate-code), a specialized open-source CLI agent with 100+ deterministic data-engineering tools: SQL anti-pattern detection, column-level lineage, dbt build/test/run against real warehouses, FinOps and cost analysis, cross-dialect translation and data parity, and PII detection.

**Why delegate?** General coding agents can edit SQL files; they can't inspect your live warehouse state. altimate-code gives Claude Code a deterministic data-engineering layer — indexed schemas, real query history, real cost data — instead of guesses.

## Install

From Anthropic's plugin directory:

```bash
claude plugin install altimate-code
```

Or from this repository's marketplace:

```
/plugin marketplace add AltimateAI/altimate-claude-plugin
/plugin install altimate-code@altimate-claude-plugin
```

## Prerequisites

The altimate-code CLI must be installed and configured on your PATH. Either install method works:

```bash
npm install -g altimate-code                       # requires Node 20+; exposes `altimate` and `altimate-code`
curl -fsSL https://www.altimate.sh/install | bash  # standalone binary; exposes `altimate`
altimate                                           # launch the TUI, then run /connect to configure your LLM provider
```

The plugin invokes `altimate`, the CLI's canonical name, and falls back to `altimate-code` for npm installs older than v0.7.1, so standalone installs work without an `altimate-code` alias.


Or configure a provider via environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and 20+ others — see the [altimate-code docs](https://docs.altimate.sh)).

If altimate-code is not on PATH or not configured, the plugin surfaces the failure with fix instructions rather than silently falling back to Claude's native tools.

## How it works

1. A **SessionStart hook** adds a static description of altimate-code's capabilities to the session, so Claude Code knows when a task fits.
2. When a data-engineering task fires the **skill** (or you invoke **`/altimate-code:altimate <task>`** explicitly), Claude Code runs `altimate run "<your task>"` locally with its `builder` agent.
3. altimate-code plans and executes the task using your configured LLM provider. Warehouse queries, dbt commands, and file edits run **locally under your credentials**.
4. The result is written to a local output file and surfaced back in your Claude Code conversation.

## Use an Altimate workspace

An [Altimate workspace](https://help.altimate.ai/workspaces/) holds your team's shared skills, knowledge, memory and warehouse integrations. Claude Code reaches it through altimate-code: every task the plugin hands over runs in your project, so it uses the workspace the project is linked to. Nothing in Claude Code needs configuring.

1. **Sign in to Altimate** — `altimate auth login -p altimate-backend --method "Altimate LLM Gateway"` (`altimate-code` on npm installs older than v0.7.1). It opens your browser. This also sets up the model provider altimate-code uses. You can run it from Claude Code by typing it after `!`.
2. **Link the project** — ask Claude to link the project to your workspace. It lists your workspaces with `altimate workspace list` and links the one you choose with `altimate link --workspace "<id or name>"`, or creates one with `altimate link --create`. Moving a linked project to a different workspace also needs `--yes`. `workspace list` is in newer altimate-code releases; with an older one, tell Claude the workspace's name. In a terminal, `altimate link` does the same with a picker; the picker does not work after `!` in Claude Code.
3. **Check it** — `altimate workspace status` shows the linked workspace and its page in the Altimate web app.
4. **Ask Claude** — questions about your team's conventions, standards or knowledge go to altimate-code, which answers from the workspace. Start a request with `/altimate-code:altimate` to be sure it does: *"/altimate-code:altimate what are our naming conventions for staging models?"*

What altimate-code learns during these tasks is saved to the workspace's memory and shared with your team in the CLI, the IDE and Studio. Skills added to the workspace reach the next task.

### Workspace skills

Skills added to the workspace reach your delegated tasks on their own: each altimate-code run checks the workspace for new or changed skills when it starts. They apply to altimate-code's work, not to Claude Code's own skills. From Claude Code you can also ask to (altimate-code 0.12.5 or newer):

- **List skills:** *"which altimate skills can this project use?"* runs `altimate skill list`.
- **Refresh now:** *"refresh the workspace skills"* runs `altimate workspace refresh`, for a skill a teammate just added.
- **Share a skill with your team:** *"publish my `staging-conventions` skill to the workspace"* runs `altimate skill publish staging-conventions`. The skill must be one of the project's, for example in `.claude/skills/<name>/`. Personal skills in `~/.claude/skills` are refused until you copy them into the project. To update a shared skill, edit it and publish it again.

## Example prompts

Once installed, try these in Claude Code (or prefix any of them with `/altimate-code:altimate`):

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
| Neither `altimate-code` nor `altimate` on PATH | `npm install -g altimate-code` (Node 20+) or `curl -fsSL https://www.altimate.sh/install \| bash`, then run `altimate` once to configure your provider. |
| `Unauthorized` / `No provider configured` | Run `altimate` (`altimate-code` on npm installs older than v0.7.1) to open the TUI and reconfigure your provider via `/connect`, or set the provider API key env var. |
| Task hangs for several minutes | Open `altimate` (`altimate-code` on npm installs older than v0.7.1) to check for a pending prompt in the TUI, or re-run specifying a known-good model. |
| Empty result | The task may be too ambiguous — restate with the target table, expected columns, or time window. |
| `UNKNOWN_USER` / `Database does not exist` mid-run | The CLI connects but your warehouse credentials don't match this project — reconfigure warehouse auth in the `altimate` TUI (`altimate-code` on npm installs older than v0.7.1) or `profiles.yml`. |
| `Not signed in to Altimate` | Run `altimate auth login -p altimate-backend --method "Altimate LLM Gateway"` (`altimate-code` on npm installs older than v0.7.1). |
| Answers ignore your workspace's skills or knowledge | Run `altimate workspace status` in the project. If it isn't linked, ask Claude to link it, or run `altimate link` in a terminal. |
| Plugin installed but never delegates | Confirm it's enabled: `claude plugin enable altimate-code@altimate-claude-plugin`. |

Still stuck? See [Support](#support).

## Components

- **Skill** — `skills/altimate-code/SKILL.md` — delegation logic and workspace guidance
- **Command** — `commands/altimate.md` — `/altimate-code:altimate` slash command for explicit delegation
- **Hook** — `hooks/hooks.json` — SessionStart capability description (static text only)

## Support

- **Docs:** [docs.altimate.sh](https://docs.altimate.sh)
- **Issues:** [GitHub Issues](https://github.com/AltimateAI/altimate-claude-plugin/issues)
- **Community:** [Slack](https://altimate.studio/join-agentic-data-engineering-slack)
- **Email:** support@altimate.ai · security reports: security@altimate.ai

## License

MIT — see [LICENSE](../../LICENSE).
