# Privacy Policy — Altimate Code plugin for Claude Code

**Effective date:** November 2, 2026
**Last revised:** November 23, 2026
**Applies to:** the `altimate-code` Claude Code plugin distributed from this repository, and the data flows it initiates through the [altimate-code](https://github.com/AltimateAI/altimate-code) MCP server and CLI.

This policy supplements the Altimate AI [Privacy Policy](https://www.altimate.ai/privacy) and [Terms](https://www.altimate.ai/terms), which govern Altimate services generally. Where this document is silent, the master policy applies. Questions: **info@altimate.ai**.

---

## The short version

- When the plugin is enabled, Claude Code launches a local `altimate-code mcp serve` process for direct data tools. This requires a build containing `mcp serve`; if the server cannot start or is disallowed, the same tools run through `altimate tool run`. These direct execution paths do not run a local planning model, but workspace services may use backend models as described below.
- MCP tool results, including sampled column values and query results, enter the Claude Code conversation and therefore reach your configured model provider. Workspace tools can send requests to Altimate services, including backend models used by `ask_knowledge_base`.
- In a project linked to an Altimate workspace, its workspace-rules hooks start the local altimate-code CLI, which pulls the workspace's approved team rules into the session. The hooks also hand your messages and the location of the session transcript to the CLI. With learning on, the CLI keeps corrections on your machine and may send a digest of the session, which can include file contents, command output and query results, to altimate-code's own model (not Claude Code's) to word a proposed team rule. A proposal reaches your workspace only when you send or approve it. The CLI also sends usage telemetry about team rules. See [Workspace rules](#workspace-rules).
- When a task **is** delegated, your task text is passed to the altimate-code CLI, which sends it to an LLM provider to plan and execute the work — the Altimate LLM Gateway by default, or a provider you configure (BYOK).
- Warehouse queries, dbt commands, and file edits run **locally on your machine, under your credentials**. Your warehouse credentials are never sent to Altimate.
- In a project linked to an Altimate workspace, the plugin copies the workspace's team skills into the project's `.claude/skills/` and refreshes them from Altimate in the background at session start and at most hourly. Their text loads into the Claude Code conversation like any project skill. `ALTIMATE_CLAUDE_SKILL_SYNC=0` turns this off and removes the copies at the next session start.
- The plugin counts its own use anonymously, through the altimate-code CLI's usage telemetry: one event at each session start (plugin and altimate-code versions, OS, a random install id) and one each time a panel or command opens or a gate holds or allows a command (its name and outcome); `/savings` sends none. No session id, project, model, column or file names, SQL or session text, and nothing that links them to your account or to the CLI's other telemetry. `ALTIMATE_TELEMETRY_DISABLED=true` turns it off. See [Plugin usage events](#plugin-usage-events).
- Installing the plugin is an explicit act — `/plugin marketplace add` does not install it, and `/plugin install` never auto-runs. Nothing is delegated until the plugin is installed and you send a task that matches the skill.

## What the plugin does and does not do

The plugin registers a local stdio MCP server through `.mcp.json`, provides routing skills and slash commands, and runs hooks: SessionStart prints a capability description and, with Stop, keeps the linked workspace's skills copied into the project (see below); in a linked project, the workspace-rules hooks (SessionStart, UserPromptSubmit and Stop) start the local altimate-code CLI (see [Workspace rules](#workspace-rules)); an opt-in PreToolUse guard checks Bash commands locally. The server reads configured connections and runs data tools under your local credentials. The plugin opens no network connection of its own for analytics: its anonymous usage events go through the altimate-code CLI's telemetry (see [Plugin usage events](#plugin-usage-events)), which is described below.

## Data flows through MCP tools

| Data | Where it goes | Retention |
|---|---|---|
| Database credentials and connection configuration | Read locally by the MCP server to connect to your databases | Local configuration; not included in tool results |
| Schema metadata, sampled column values, and query results returned by tools | Local MCP server → Claude Code conversation → your configured model provider | Governed by Claude Code and your model provider's policies |
| Scratch tables and spilled query results | Local session storage or spill files; any content Claude reads enters the conversation and reaches your model provider | Local artifacts; conversation copies follow Claude Code and provider policies |

## dbt helpers

In a dbt project the plugin's hooks module runs the project's own dbt on this machine (`dbt show`, `dbt parse`, `dbt --version`, and `dbt debug` when you ask): after Claude edits a model, at session start, and when you press a button. Those commands connect to your warehouse with your local profile. What the helpers give Claude (dbt's errors, column names, the manifest's facts about a model, the environment check) enters the Claude Code conversation and reaches your model provider. Rows from `dbt show` that the results pane keeps (up to 50 per query, long cells cut, and the last 20 queries) stay in Claude Code's local plugin store until you press **Clear history**; they are not sent anywhere by the plugin. Bookmarked queries (at most 50) are the exception: **Clear history** keeps them and their rows. They are kept with the plugin's other saved settings in Claude Code's plugin store under the Claude Code configuration directory, in files only your user can read, and turning `dbt_mods` off does not delete them; to delete one, un-bookmark it and press **Clear history**. Set the plugin's `dbt_mods` option to false to turn the helpers off.

Opening a dbt folder runs programs the repository supplies, with no action from you: at session start the plugin runs the project's own `.venv/bin/dbt --version` (a `venv` or `Scripts\dbt.exe` too) and the Python that dbt's launcher names. Secret values from the `profiles.yml` a dbt command reads (the one its `--profiles-dir` or `DBT_PROFILES_DIR` names, else the one in the folder it ran in, the project's, or `~/.dbt`'s: the string fields of its outputs, and the env vars it names with their defaults) are removed from dbt's messages (errors, logs, the doctor's details, the failure band, Explain and Fix, and the error text kept in the query history) that the helpers show, save or send, and dbt's errors about a `profiles.yml` it cannot read, validate or render are replaced with a fixed message. Identifiers such as schema, database, dataset, project, catalog, warehouse, role and user are not treated as secrets, nor are values under 6 characters or the `type`, `threads`, `method` and `port` fields; query results and manifest facts are shown as they are. The plugin reads those values locally, keeps them in memory only, and never logs, stores or sends them. Redaction is best effort, not a guarantee about every text dbt prints: it matches those values as written, JSON-escaped and in Python's string and byte forms, including values set for the command (`NAME=value dbt …`, `env`, `export`); it cannot catch a value dbt or an adapter prints in another form (encoded, transformed or split), or one the profile builds other than through `env_var`. Other dbt errors (a missing target or profile name, a model's own missing `env_var`) are kept, since they carry no secret. Claude's own dbt commands show their output to Claude unchanged; the plugin does not alter Claude's tool results.

Direct local data tools do not invoke a planning model. Workspace tools have the additional service flows below; delegation uses the separate provider path described later.

## Data flows for workspace tools

When workspace tools are enabled in a linked project, requests use your Altimate sign-in and workspace identity. Tool results enter the Claude Code conversation and reach its configured model provider.

| Data | Where it goes | Retention |
|---|---|---|
| Questions, SQL and other arguments sent through `workspace_context`, `workspace_skill` and `workspace_execute` (MCP, or `tool run --workspace-tools`) | Your Altimate tenant; knowledge questions (`ask_knowledge_base`) are answered by Altimate's backend models | Governed by the Altimate privacy policy and applicable service terms |
| Workspace SQL, connection identifiers, and metadata requests | Workspace engine and configured database services; results return through the tool to Claude Code | Governed by the workspace, database, Altimate service, and model-provider policies |
| Workspace metadata, knowledge, and returned results | Local tool process → Claude Code conversation → configured model provider | Governed by Claude Code and provider policies |

These service calls are separate from local CLI delegation. Configuring BYOK for delegation does not redirect workspace backend model calls. To keep these requests from being sent, do not link the project to an Altimate workspace; without a link the workspace tools send no questions or SQL; they only list your workspaces so one can be chosen.

## Data flows for workspace skills

| Data | Where it goes | Retention |
|---|---|---|
| Team skills of the linked Altimate workspace | Fetched by `altimate workspace refresh` from your Altimate tenant (at session start when over an hour old, hourly from the Stop hook, or with `/altimate-code:refresh-skills`) into `.altimate-code/skill/_workspace/`, then copied into `.claude/skills/` | Local files, kept out of git; removed at the next session start when the workspace drops a skill, the project is unlinked, you sign in to another account or `ALTIMATE_CLAUDE_SKILL_SYNC=0` is set. Uninstalling the plugin leaves them: delete the `.claude/skills/` folders that contain `.altimate-workspace-skill` |
| Text of a skill Claude uses | Claude Code conversation → your configured model provider | Governed by Claude Code and your model provider's policies |

Refresh uses your existing Altimate sign-in. Projects altimate-code has never worked in are skipped. Set `ALTIMATE_CLAUDE_SKILL_SYNC=0` to turn copying and refresh off and remove the copies.

## Your skill and knowledge requests

Since plugin 1.7.0, in an interactive session the plugin runs `altimate workspace review decisions` at session start and every 15 minutes. The local CLI asks your Altimate workspace for the review status of the skills and knowledge bases you sent for review, using your existing sign-in, and the plugin shows each new decision as a toast. `/altimate-code:rules` runs `altimate workspace review status` when you use it.

| Data | Where it goes | Retention |
|---|---|---|
| Your requests' status, the reviewer's name and their reason | Read by the local CLI from your Altimate workspace; shown as a toast and, at session start, given to Claude Code as session context | The decisions and which of them were shown are kept in altimate-code's state directory (`$XDG_STATE_HOME/altimate-code/workspace-reviews/`), per account and workspace, the 50 most recent |
| A request's name, reviewer and reason in Claude's context | Claude Code conversation → your configured model provider | Governed by Claude Code and your model provider's policies |

Nothing is sent but the request for your own requests' status. Signed out, with workspaces off or in a project that is not linked, no request is made.

## Workspace rules

**When the hooks start the CLI.** The workspace-rules hooks start the local altimate-code CLI only when the folder the session starts in, or a folder above it in the repository, is named in altimate-code's workspace link cache (`altimate-workspace-bindings.json`, in your own state directory). Elsewhere they start nothing. No file in the repository decides this: a branch or a merge can bring files into it. With `ALTIMATE_LEARN=0` (or `false`) no hook starts the CLI.

**What needs what.**

- *Team rules.* In a linked project, the CLI pulls the workspace's approved team rules at session start when workspaces are on (`ALTIMATE_DISABLE_WORKSPACE` is not set), you are signed in to Altimate and `ALTIMATE_LEARN` is not `0`. This does not depend on the learning setting.
- *Recording corrections and drafting proposed rules* also need learning on. Learning is on when you turned it on in the project (`altimate learn enable`) or, if you have made no choice of your own, when the workspace owner turned on the workspace's "Learn from sessions" setting. Your own choice (`altimate learn enable` or `altimate learn disable`) overrides the workspace setting, unless your organization enforces a policy.
- In a linked folder, the per-turn hooks hand each message you send and the location of the session transcript to the local CLI whether or not learning is on. When you are signed out, workspaces are off or the project is not linked, the CLI discards them and nothing leaves your machine. When learning is off, the CLI discards them too, but after each turn it still pulls the team rules and sends proposals you already answered and rule usage counts (no message or transcript text).

**The digest used to word a proposed rule.** After a turn with new corrections, the CLI reads the Claude Code session transcript (its last 8 MB) and builds a digest of the session: your prompts, the input and output of each tool call (up to 300 and 400 characters per call, so file contents, command output and warehouse query results can appear), and the final reply, at most 24,000 characters in total. Secrets in the digest are masked; no other data is removed. The digest is sent to altimate-code's own model: the model named by `ALTIMATE_LEARN_MODEL`, otherwise the one set as `learn.model` in altimate-code's configuration, otherwise altimate-code's default model, which is the Altimate LLM Gateway or another provider configured for altimate-code. This is not the model Claude Code uses; it is a party that does not otherwise see your Claude Code session. If altimate-code has no model it can use, nothing is sent, and the next session start reports that the check failed. The CLI makes at most one such model call per check round, and a few per turn at most.

| Data | Where it goes | Retention |
|---|---|---|
| Your workspace's approved team rules | Pulled by the local CLI from your Altimate workspace, given to Claude Code as session context | Mirrored locally in the project's git-ignored `.altimate-code/` directory, and given only while altimate-code's own rules state holds the same rules and you are signed in as the account they were pulled for. That state, which also keeps proposals waiting to be sent and your review notices, is in your own state directory (`$XDG_STATE_HOME/altimate-code/workspace-rules/`, usually `~/.local/state/altimate-code/workspace-rules/`), outside the project. This needs an altimate-code release that keeps the rules state there; earlier releases keep it in the project's `.altimate-code/learn/workspace-rules/` folder |
| Each message you send | Handed to the local CLI, which checks it with no model call; with learning on, a message that reads as a correction is kept (secrets redacted) | Local only, in the project's git-ignored `.altimate-code/` directory |
| The session transcript, after a turn with new corrections (learning on) | Read locally by the CLI; the digest described above goes to altimate-code's own model to word one proposed rule | The transcript stays local; the model provider's handling is as for delegated tasks below |
| A proposed rule, with an excerpt of your correction if your workspace allows quotes | Your Altimate workspace's review queue, only when you send or approve it in `/altimate-code:rules` or `altimate learn proposals` | Per the Altimate Privacy Policy |
| Rule usage counts (sessions a rule was shown in, corrections after it) | Your Altimate workspace | Per the Altimate Privacy Policy |
| Rules telemetry events: `rules_sync`, `rules_delivered`, `rule_drafted`, `rule_proposal_shown`, `rule_proposal_answered`, `rule_proposal_skipped`, `rule_remember_routed`, and `rules_command` (the name of each `learn` subcommand you run, such as `learn proposals`; not sent for the hooks' own calls). Events about a session carry its id, `claude:<id>` for a Claude Code session. No rule text, prompts or file paths | Altimate's usage telemetry, as described in [Usage telemetry](#usage-telemetry) | As for usage telemetry; turned off with the telemetry opt-out there |

Turn off recording and drafting with `altimate learn disable` in the project, or, for members who have made no choice of their own, with the workspace's "Learn from sessions" setting. `ALTIMATE_LEARN=0` turns off all of it, including the team rules pull, and the hooks then start nothing.

The delegation path below runs only when the delegation skill or the `/altimate-code:altimate` command fires and invokes the locally installed altimate-code CLI.

## The lineage report

The column impact report is one HTML file that the plugin writes to the project's `target/.altimate-lineage/` and opens in your browser. The page loads nothing from the network: its content-security policy allows only its own inline script and style.

To learn whether the report gets used, the plugin asks the local altimate-code CLI (`altimate-code tool report-event`) to send one usage event, `lineage_report`, at each of these steps:
- the summary was shown;
- **Open report** was pressed;
- `/lineage-report` was run;
- the report was built, failed to build, or found no browser.

Each event carries the step and the Claude Code session id (`claude:<id>`) only: no model, column, file or project names. It goes through Altimate's usage telemetry, described in [Usage telemetry](#usage-telemetry), and that section's opt-out turns it off; with `ALTIMATE_TELEMETRY_DISABLED` set, the plugin does not start the CLI for it. With an altimate-code that predates the command, nothing is sent.

## Plugin usage events

To count installs, active use and which features are used, the plugin asks the local altimate-code CLI (`altimate-code tool report-event`) to send these events through Altimate's usage telemetry, described in [Usage telemetry](#usage-telemetry). The plugin itself contacts no server for them.

| Event | When | Fields |
|---|---|---|
| `plugin_session_start` | Each time Claude Code starts a session with the plugin enabled | `plugin_version`; `altimate_code_version` (added by the CLI); `host_os` (the plugin passes it as `--os`): `macos`, `linux`, `windows`, `wsl` or `unknown`; `install_id` |
| `plugin_feature_used` | A panel or command opens: `/lineage` or the summary's **Open lineage** (`lineage`), `/dbt-show` (`dbt_show`), `/profile-ctes` (`profile_ctes`), `/scan-cost` (`scan_cost`), `/comments` or the band's **Open** (`comments`), `/sql-graph` (`sql_graph`), `/health` (`health`), `/runs` (`runs`), `/to-model` (`to_model`); the cost check holds a dbt command or `/allow-scan` allows it (`cost_gate`); with "Project health blocks git push" on, the push gate holds or lets through a `git push` (`health_push_gate`). Panes the plugin opens on its own, following Claude, are not counted | `feature` (the name in brackets); `outcome`: `opened`, `failed` (the panel could not open or be shown), `held` or `allowed`; `plugin_version`; `install_id` |

- **`install_id`** is a random UUID the plugin makes the first time it sends an event and keeps in its own Claude Code plugin store (a JSON file under your Claude Code configuration directory), so it stays the same across sessions on this machine. It is not derived from your machine, account or project, and is not made while `ALTIMATE_TELEMETRY_DISABLED` is set. Removing the plugin's store data makes a new one.
- Beside these fields, each event carries only the CLI version (`cli_version`), the client name (`client`: `altimate-code`) and how the CLI was started (`source`: `cli`, unless `ALTIMATE_CLI_CLIENT` names another client). Unlike the CLI's other events, these carry no session id, no machine id, no project id, no per-launch id and never your Altimate account (no user id or tenant), even when you are signed in, so they cannot be joined to the CLI's other telemetry.
- No event contains project, model, column or file names, SQL, query results or session text. The CLI accepts each field only from a fixed list or pattern (a version, a UUID, one of the names above) and refuses anything else.
- **Turning it off:** `ALTIMATE_TELEMETRY_DISABLED=true` (or `1`) in the environment Claude Code starts in: the plugin then starts no CLI for these events, or for the lineage report's, and makes no install id. The CLI also drops them under its own opt-out (`ALTIMATE_TELEMETRY_DISABLED`, or `telemetry.disabled` in its config), as for every other event.
- The events are sent in the background and never delay a hook. An altimate-code that predates them refuses them, and nothing is sent or shown.
- **`/savings` sends no usage event.** Typing it, pressing its buttons and opening its pane are not counted, and nothing about the check (its queries, findings or amounts) goes to Altimate. See [The Databricks savings check](#the-databricks-savings-check).

## Data flows when a task is delegated

| Data | Where it goes | Retention |
|---|---|---|
| Your task prompt (verbatim) | Local altimate-code CLI → your configured LLM provider | Altimate LLM Gateway does not retain full prompts and responses after processing. BYOK providers: governed by that provider's policy — Altimate never sees this traffic. |
| Warehouse credentials (`profiles.yml`, env vars) | Stay on your machine; used locally by the CLI | Never transmitted to Altimate |
| Warehouse query results, dbt output, file edits | Produced locally; data supplied to the CLI agent reaches its configured LLM provider. Output read back into Claude Code reaches Claude Code's model provider. | Local output files; provider copies follow the applicable provider policies |
| Schema metadata indexed by the CLI | Local index on your machine | Local only |

**Bring Your Own Key (BYOK):** if you configure your own provider (Anthropic, OpenAI, Bedrock, Azure OpenAI, Ollama, and others), your prompts go directly from your machine to that provider. Altimate is not in that delegation path; workspace service requests still go to Altimate.

## The Databricks savings check

`/savings` runs altimate-code's `finops_databricks_savings` tool on your machine, with your own Databricks connection. It reads usage from your workspace's system tables and decides the savings locally. The plugin runs it with telemetry turned off, in altimate-code's assessment mode (`ALTIMATE_ASSESSMENT_MODE=true`) and outside its tool daemon. In assessment mode the CLI sends no usage event, not even the one-time telemetry opt-out event, and does not fetch the model catalog or download ripgrep, so your warehouse is the only host the run contacts; an altimate-code release without assessment mode ignores the setting and would still send that opt-out event and make those fetches, so the plugin first asks `altimate --version` (which sends nothing) and does not start release 0.12.12 or older, or a source build (which prints `local` whatever its age), for the check. The plugin sends no usage event of its own for `/savings` either (see [Plugin usage events](#plugin-usage-events)), so nothing about the check, its queries or its results goes to Altimate. The findings are shown in a pane, not added to the conversation. Not assessed: Databricks Apps spend; a serverless SQL warehouse gets only the over-sized check. The run starts the connection's SQL warehouse if it is stopped, and needs the `@databricks/sql` driver installed. Costs cover the six full billed days before the window's last day, scaled to seven, which read about 7% below the seven billed days on one measured workspace. To show a flagged warehouse's observed spend before and after a later change, the plugin keeps its size, type and weekly cost in Claude Code's local plugin store on your machine. **Draft the fix** puts one finding's details in your prompt box; they reach your model provider only if you send that prompt. When Claude runs the same tool itself, its answer is a tool result like any other and reaches your model provider.

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

**November 23, 2026:** added [The Databricks savings check](#the-databricks-savings-check) (plugin 1.9.0): `/savings` runs altimate-code's savings tool with telemetry off, sends no plugin usage event, and keeps the findings out of the conversation.

**November 19, 2026:** added [Plugin usage events](#plugin-usage-events) (plugin 1.8.2): the anonymous session start and feature-used events, and the plugin's own check of the telemetry opt-out.

**November 17, 2026:** added [dbt helpers](#dbt-helpers) (plugin 1.8.0): the dbt commands the plugin runs in a dbt project, and what it keeps of their results.

**November 16, 2026:** added [The lineage report](#the-lineage-report) (plugin 1.6.0): the offline report page, and the usage events the altimate-code CLI sends for it.

**November 10, 2026:** added [Workspace rules](#workspace-rules) (the workspace-rules hooks and `/altimate-code:rules` in plugin 1.5.0), and the rules telemetry the altimate-code CLI sends.

## Contact

Altimate Inc. · 440 North Wolfe Road #150, Sunnyvale, CA 94085, USA · +1 (650) 254-6266
Privacy & general: **info@altimate.ai** · Security: **security@altimate.ai** · Support: **support@altimate.ai**
