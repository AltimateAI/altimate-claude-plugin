# Privacy Policy — Altimate Code plugin for Claude Code

**Effective date:** July 9, 2026
**Applies to:** the `altimate-code` Claude Code plugin distributed from this repository, and the data flows it initiates through the [altimate-code](https://github.com/AltimateAI/altimate-code) CLI.

This policy supplements the Altimate AI [Privacy Policy](https://www.altimate.ai/privacy) and [Terms](https://www.altimate.ai/terms), which govern Altimate services generally. Where this document is silent, the master policy applies. Questions: **info@altimate.ai**.

---

## The short version

- The plugin itself collects **no data**. It is a routing layer (skills, slash commands, and session hooks) that tells Claude Code when to delegate a task to the altimate-code CLI installed on your machine.
- In a project linked to an Altimate workspace with learning on, its workspace-rules hooks hand your messages and the session transcript to the local altimate-code CLI, which keeps corrections on your machine and may send a digest to your LLM provider to word a proposed team rule. A proposal reaches your workspace only when you send or approve it. See [Workspace rules](#workspace-rules).
- When a task **is** delegated, your task text is passed to the altimate-code CLI, which sends it to an LLM provider to plan and execute the work — the Altimate LLM Gateway by default, or a provider you configure (BYOK).
- Warehouse queries, dbt commands, and file edits run **locally on your machine, under your credentials**. Your warehouse credentials are never sent to Altimate.
- Installing the plugin is an explicit act — `/plugin marketplace add` does not install it, and `/plugin install` never auto-runs. Nothing is delegated until the plugin is installed and you send a task that matches the skill.

## What the plugin does and does not do

The plugin contains no executable service of its own. At session start, a hook prints a fixed, static text block describing the skill's capabilities. The workspace-rules hooks (see below) call the locally installed altimate-code CLI. The plugin does not phone home and does not collect analytics.

Data leaves Claude Code's process only when the delegation skill, the `/altimate-code:altimate`, `/altimate-code:review` or `/altimate-code:rules` command, or a workspace-rules hook invokes the locally installed altimate-code CLI.

## Workspace rules

These hooks act only in a project linked to an Altimate workspace, with learning on, workspaces on and you signed in to Altimate. Otherwise the session-start hook reads only local altimate-code state and sends nothing, and the per-turn hooks do not run the CLI at all in a project without workspace rules state.

| Data | Where it goes | Retention |
|---|---|---|
| Your workspace's approved team rules | Pulled by the local CLI from your Altimate workspace, given to Claude Code as session context | Mirrored locally in the project's git-ignored `.altimate-code/` directory |
| Each message you send | The local CLI checks it, with no model call; a message that reads as a correction is kept (secrets redacted) | Local only, in the project's git-ignored `.altimate-code/` directory |
| The session transcript, after a turn with new corrections | Read locally by the CLI; a bounded, redacted digest goes to your configured LLM provider to word one proposed rule | Local only; the provider's handling is as for delegated tasks above |
| A proposed rule, with an excerpt of your correction if your workspace allows quotes | Your Altimate workspace's review queue, only when you send or approve it in `/altimate-code:rules` | Per the Altimate Privacy Policy |
| Rule usage counts (sessions a rule was shown in, corrections after it) | Your Altimate workspace | Per the Altimate Privacy Policy |

Turn this off with `altimate-code learn disable` in the project, `ALTIMATE_LEARN=0`, or the workspace's "Learn from sessions" setting.

## Data flows when a task is delegated

| Data | Where it goes | Retention |
|---|---|---|
| Your task prompt (verbatim) | Local altimate-code CLI → your configured LLM provider | Altimate LLM Gateway does not retain full prompts and responses after processing. BYOK providers: governed by that provider's policy — Altimate never sees this traffic. |
| Warehouse credentials (`profiles.yml`, env vars) | Stay on your machine; used locally by the CLI | Never transmitted to Altimate |
| Warehouse query results, dbt output, file edits | Produced locally; written to a local output file surfaced back to Claude Code | Local only |
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

- **Don't enable the plugin** — it ships disabled; nothing is delegated until you enable it.
- **Use BYOK** — route prompts directly to your own provider so Altimate never sees them.
- **Disable telemetry** — see above.
- **Contact us** — for access, correction, or deletion requests, email **info@altimate.ai**.

## Children

The plugin and the altimate-code CLI are professional developer tools, not directed at children, and not intended for use by anyone under 18.

## Changes to this policy

We will update this document in this repository and revise the effective date when our practices change. Material changes to Altimate-wide practices are governed by the master [Privacy Policy](https://www.altimate.ai/privacy).

## Contact

Altimate Inc. · 440 North Wolfe Road #150, Sunnyvale, CA 94085, USA · +1 (650) 254-6266
Privacy & general: **info@altimate.ai** · Security: **security@altimate.ai** · Support: **support@altimate.ai**
