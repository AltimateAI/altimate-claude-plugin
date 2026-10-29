# Privacy Policy — Altimate Code plugin for Claude Code

**Effective date:** October 17, 2026
**Applies to:** the `altimate-code` Claude Code plugin distributed from this repository, and the data flows it initiates through the [altimate-code](https://github.com/AltimateAI/altimate-code) MCP server and CLI.

This policy supplements the Altimate AI [Privacy Policy](https://www.altimate.ai/privacy) and [Terms](https://www.altimate.ai/terms), which govern Altimate services generally. Where this document is silent, the master policy applies. Questions: **info@altimate.ai**.

---

## The short version

- When the plugin is enabled, Claude Code launches a local `altimate-code mcp serve` process for direct data tools. This requires a build containing `mcp serve`; if the server cannot start or is disallowed, the same tools run through the model-free `altimate tool run` CLI, which makes no LLM calls either.
- MCP tool results, including sampled column values and query results, enter the Claude Code conversation and therefore reach your configured model provider. The local MCP server makes no separate LLM calls.
- When a task **is** delegated, your task text is passed to the altimate-code CLI, which sends it to an LLM provider to plan and execute the work — the Altimate LLM Gateway by default, or a provider you configure (BYOK).
- Warehouse queries, dbt commands, and file edits run **locally on your machine, under your credentials**. Your warehouse credentials are never sent to Altimate.
- In a project linked to an Altimate workspace, the plugin copies the workspace's team skills into the project's `.claude/skills/` and refreshes them from Altimate in the background at session start and at most hourly. Their text loads into the Claude Code conversation like any project skill. `ALTIMATE_CLAUDE_SKILL_SYNC=0` turns this off.
- Installing the plugin is an explicit act — `/plugin marketplace add` does not install it, and `/plugin install` never auto-runs. Nothing is delegated until the plugin is installed and you send a task that matches the skill.

## What the plugin does and does not do

The plugin registers a local stdio MCP server through `.mcp.json`, provides routing skills and slash commands, and runs hooks: SessionStart prints a capability description and, with Stop, keeps the linked workspace's skills copied into the project (see below); an opt-in PreToolUse guard checks Bash commands locally. The server reads configured connections and runs data tools under your local credentials. The plugin adds no analytics of its own; CLI telemetry is described below.

## Data flows through MCP tools

| Data | Where it goes | Retention |
|---|---|---|
| Database credentials and connection configuration | Read locally by the MCP server to connect to your databases | Local configuration; not included in tool results |
| Schema metadata, sampled column values, and query results returned by tools | Local MCP server → Claude Code conversation → your configured model provider | Governed by Claude Code and your model provider's policies |
| Scratch tables and spilled query results | Local session storage or spill files; any content Claude reads enters the conversation and reaches your model provider | Local artifacts; conversation copies follow Claude Code and provider policies |

The MCP server makes no separate LLM calls. Delegation uses the separate provider path below.

## Data flows for workspace skills

| Data | Where it goes | Retention |
|---|---|---|
| Team skills of the linked Altimate workspace | Fetched by `altimate workspace refresh` from your Altimate tenant (at session start when over an hour old, hourly from the Stop hook, or with `/altimate-code:refresh-skills`) into `.altimate-code/skill/_workspace/`, then copied into `.claude/skills/` | Local files, kept out of git; removed when the workspace drops a skill, the project is unlinked or you sign in to another tenant |
| Text of a skill Claude uses | Claude Code conversation → your configured model provider | Governed by Claude Code and your model provider's policies |

Refresh uses your existing Altimate sign-in. Projects altimate-code has never worked in are skipped. Set `ALTIMATE_CLAUDE_SKILL_SYNC=0` to turn copying and refresh off.

The delegation path below runs only when the delegation skill or the `/altimate-code:altimate` command fires and invokes the locally installed altimate-code CLI.

## Data flows when a task is delegated

| Data | Where it goes | Retention |
|---|---|---|
| Your task prompt (verbatim) | Local altimate-code CLI → your configured LLM provider | Altimate LLM Gateway does not retain full prompts and responses after processing. BYOK providers: governed by that provider's policy — Altimate never sees this traffic. |
| Warehouse credentials (`profiles.yml`, env vars) | Stay on your machine; used locally by the CLI | Never transmitted to Altimate |
| Warehouse query results, dbt output, file edits | Produced locally; data supplied to the CLI agent reaches its configured LLM provider. Output read back into Claude Code reaches Claude Code's model provider. | Local output files; provider copies follow the applicable provider policies |
| Schema metadata indexed by the CLI | Local index on your machine | Local only |

**Bring Your Own Key (BYOK):** if you configure your own provider (Anthropic, OpenAI, Bedrock, Azure OpenAI, Ollama, and others), your prompts go directly from your machine to that provider. Altimate is not in the path.

## Usage telemetry

The altimate-code CLI emits anonymous product usage telemetry: event names, tool categories, token counts, timing, and error types. Telemetry never includes your code, queries, credentials, file paths, or prompt content, and error messages pass through a redaction layer (API keys, emails, and internal hostnames are masked). Events are keyed to an anonymous machine ID — a random UUID generated on first run and stored at `~/.altimate/machine-id`, not tied to your hardware or identity. For logged-in users, the email identifier is SHA-256 hashed before sending. The full event list is published in the [Telemetry reference](https://docs.altimate.sh/reference/telemetry/).

**Disabling telemetry:** set the environment variable `ALTIMATE_TELEMETRY_DISABLED=true`, or add the following to `~/.config/altimate-code/altimate-code.json`:

```json
{ "telemetry": { "disabled": true } }
```

**Retention:** telemetry is sent to Azure Application Insights and retained according to Microsoft's data retention policies; we do not maintain a separate telemetry data store. To request deletion of your telemetry data, contact **privacy@altimate.ai**.

## Third parties

- **LLM providers** — the provider you configure processes your prompts under its own terms and privacy policy. The default Altimate LLM Gateway is operated by Altimate; see the [Security FAQ](https://docs.myaltimate.com/arch/faq/) for its data handling.
- **Cloud infrastructure** — Altimate services and telemetry run on major cloud providers with encryption in transit (TLS) and at rest.
- **Anthropic** — your use of Claude Code itself is governed by Anthropic's terms and privacy policy, independent of this plugin.

We do not sell your data, and we do not use your data to train models.

## Security

All data transmitted to Altimate services is encrypted in transit using TLS. Altimate AI is SOC 2 Type 2 certified. To report a vulnerability, email **security@altimate.ai** (see [SECURITY.md](./SECURITY.md)).

## Your choices

- **Don't enable the plugin** — no plugin MCP server is launched and no tasks are delegated while it is disabled.
- **Use BYOK for delegation** — route CLI agent prompts directly to your own provider. MCP tool results are handled by Claude Code's configured model provider independently.
- **Disable telemetry** — see above.
- **Contact us** — for access, correction, or deletion requests, email **info@altimate.ai**.

## Children

The plugin and the altimate-code CLI are professional developer tools, not directed at children, and not intended for use by anyone under 18.

## Changes to this policy

We will update this document in this repository and revise the effective date when our practices change. Material changes to Altimate-wide practices are governed by the master [Privacy Policy](https://www.altimate.ai/privacy).

## Contact

Altimate Inc. · 440 North Wolfe Road #150, Sunnyvale, CA 94085, USA · +1 (650) 254-6266
Privacy & general: **info@altimate.ai** · Security: **security@altimate.ai** · Support: **support@altimate.ai**
