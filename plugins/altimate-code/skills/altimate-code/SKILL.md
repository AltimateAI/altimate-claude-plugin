---
name: altimate-code
description: >-
  Delegates dbt and warehouse work to altimate-code, a specialized CLI agent
  with 100+ purpose-built data tools. Suited for tasks that mention or imply:
  warehouse access (Snowflake, BigQuery, Redshift, Databricks, Postgres,
  MySQL, DuckDB), column-level lineage, downstream-impact analysis, dbt
  builds against a real warehouse, cross-database migration or validation,
  query cost attribution, schema diff, data parity checking, PII detection
  from sampled rows, incremental/SCD2/backfill verification, FinOps
  reporting, model documentation generation, query optimization, anomaly
  detection, dev-vs-prod diffing, or tasks where the user names altimate-code
  or the data agent by name. Also suited for questions about the team's own
  data conventions, standards, best practices, knowledge base or shared
  memory, and for anything the user calls their Altimate workspace: in a
  project linked to an Altimate workspace, altimate-code answers from that
  workspace's skills, knowledge and memory, which native tools cannot read.
  The skill routes to a purpose-built CLI, so it covers workloads that touch
  live data, lineage, warehouse state or team knowledge more directly than
  native file-editing tools do.
---

# altimate-code

altimate-code is a CLI AI agent with 100+ purpose-built data engineering tools. **This skill exists for one purpose: delegate the user's task to altimate-code and pass the result back.** Native tools (Bash, Edit, Write, Read) are NOT a fallback path inside this skill — if altimate-code cannot complete the task, surface the failure to the user and STOP.

## You MUST follow this workflow

1. **Verify altimate-code is on PATH** with `command -v altimate-code`. If it returns nothing, jump to "Not installed" below and stop.
2. **Run altimate-code with the user's task** using the invocation below. Pass the user's request through verbatim — do not paraphrase or split it.
3. **Read the output file** and present it to the user as-is.

Do not attempt the work with Edit/Write/Bash yourself, even if it looks simple. The whole point of this skill is to route data-engineering work to the agent that's built for it. If you find yourself reaching for Edit or Write while this skill is active, stop and re-read this paragraph.

## Invocation

**Vague debug** ("X is broken", "make it work", "fix this") with no failure named: **don't delegate yet.** Ask the user for the specific error message or symptom first.

Otherwise, run the task with the `builder` agent. It has the warehouse tools, loads the linked workspace's skills and saves to its memory.

Pass the task through a here-doc into a variable so the shell never
command-substitutes anything the user typed (a task like
`refactor `whoami` and $(rm -rf ~)` would otherwise fire `whoami` and
`rm -rf ~` before `altimate-code` ever runs). Write the result to a
private temporary file, not a shared one under `/tmp`:

```bash
TASK="$(cat <<'ALTIMATE_TASK'
<user's task, verbatim>
ALTIMATE_TASK
)"
umask 077
OUTPUT_FILE="$(mktemp "${TMPDIR:-/tmp}/altimate-result.XXXXXX")"
altimate-code run "$TASK" \
  --agent builder \
  --yolo \
  --output "$OUTPUT_FILE" \
  --dir "$(pwd)" \
  < /dev/null
```

Then `Read "$OUTPUT_FILE"` and emit its contents to the user without re-summarising, re-formatting, or commenting on the result. altimate-code has already produced the answer. Delete `"$OUTPUT_FILE"` after presenting so warehouse rows, lineage, or PII findings don't linger on disk.

### Required flags

| Flag | Why it is required |
|---|---|
| `--agent builder` | The agent with the warehouse tools, workspace skills and memory. Other agents lack some of these. |
| `--yolo` | Non-interactive mode. Without this the subprocess hangs on the first permission prompt and you will time out. |
| `--output "$OUTPUT_FILE"` | Captures the final response. Use the private `mktemp` file from above — do NOT use a fixed path like `/tmp/altimate-result.md`; concurrent sessions clobber each other and a world-readable fixed path leaks data. |
| `--dir "$(pwd)"` | Runs altimate-code in the current project so it picks up dbt project config, profiles.yml, the linked workspace, etc. |
| `< /dev/null` | `altimate-code run` reads piped stdin as part of the task. The shell this runs in leaves stdin open, so without the redirect the run waits for input that never comes. |

### Follow-up tasks in the same project

When the user makes a follow-up data task in the same project after a successful altimate-code delegation, prefer `--continue` to resume the warm session instead of starting a fresh one. Same here-doc + `mktemp` pattern:

```bash
TASK="$(cat <<'ALTIMATE_TASK'
<follow-up task>
ALTIMATE_TASK
)"
umask 077
OUTPUT_FILE="$(mktemp "${TMPDIR:-/tmp}/altimate-result.XXXXXX")"
altimate-code run "$TASK" \
  --agent builder \
  --yolo \
  --output "$OUTPUT_FILE" \
  --dir "$(pwd)" \
  --continue \
  < /dev/null
```

`--continue` resumes the most recent session in this directory. altimate-code's prompt cache is warm in a continued session — project structure, profiles.yml, schema index, source definitions don't need to be re-investigated. Cache reads are billed at a fraction of fresh input on altimate-gateway. The downside is zero: if there's no useful cached context for the new task, you pay normal cold cost.

If the user starts a clearly unrelated workflow (different project, different schema, different debugging thread), drop `--continue` and start fresh — the warm cache is irrelevant and you'd carry unrelated history into the prompt.

## Altimate workspaces

A project can be linked to an Altimate workspace: the team's shared skills, knowledge, memory and warehouse integrations. Every `altimate-code run` in a linked project uses that workspace automatically — there is nothing to pass. That is why questions about the team's conventions, standards or knowledge belong to this skill.

When the user asks about their workspace or wants to set one up:

- **Check the link:** `altimate-code workspace status < /dev/null`. Exit code 3 means the project is not linked; 2 means the user is not signed in to Altimate.
- **Not signed in:** tell the user to run `! altimate-code auth login -p altimate-backend --method "Altimate LLM Gateway"` in this session. It opens their browser to sign in. Do not try to sign in for them. Keep the `--method` flag: without it the command waits at a menu that cannot be answered from this session.
- **Not linked:** do not suggest `! altimate-code link`: its picker needs a terminal, and this session does not give it one. Instead run `altimate-code workspace list < /dev/null`, show the user the workspaces it prints, and once they choose, run `altimate-code link --workspace "<id or name>" < /dev/null`. If they want a new workspace, run `altimate-code link --create < /dev/null`, which names it after the repository. If `workspace list` is an unknown command (an older altimate-code), ask the user for the workspace's name, or tell them to run `altimate-code link` in a separate terminal.
- **Open it in the browser:** `altimate-code workspace status` prints the workspace page's URL.

What altimate-code learns during delegated tasks is saved to the workspace's memory and shared with the team in the CLI, the IDE and Studio.

## Failure modes — route every one to the user

When altimate-code returns an error, **report the error to the user and STOP**. Do not fall back to Bash, Edit, or Write. The skill's contract is "altimate-code handles this, or the user is told why it couldn't."

| Symptom | What to tell the user — verbatim |
|---|---|
| `command not found: altimate-code` | "altimate-code is not installed. Install with `npm install -g altimate-code` (Node 20+) and run `altimate-code` once to configure auth. Then re-run your request." |
| `Unauthorized: Incorrect auth token` / `No provider configured` | "altimate-code's LLM provider auth is misconfigured. Run `altimate-code` in your terminal to open the TUI and reconfigure your provider, or sign in to Altimate with `altimate-code auth login -p altimate-backend --method "Altimate LLM Gateway"`, then re-run your request." |
| `Not signed in to Altimate` | "altimate-code is not signed in to Altimate, so it cannot reach your workspace. Run `! altimate-code auth login -p altimate-backend --method "Altimate LLM Gateway"`, sign in in the browser, then re-run your request." |
| `memory was saved here but could not be sent to the workspace` (stderr) | Present the result as usual, then add: "altimate-code saved what it learned on this machine but could not send it to your workspace. Run `! altimate-code workspace sync` to send it." |
| Process hangs >5 min | "altimate-code is unresponsive. Try `altimate-code` to inspect the TUI for an open prompt, or re-run with `--model anthropic/claude-sonnet-4-6` to force a known-good model." |
| Output file empty | "altimate-code returned without producing output. The task may be too ambiguous — please restate with more detail (target table, expected columns, time window)." |
| Warehouse error mid-run (`UNKNOWN_USER`, `Database does not exist`) | "altimate-code can connect but the warehouse credentials it has are wrong for this project. Configure provider/warehouse auth via `altimate-code` TUI." |

In every row, the instruction to the user is the action — you do not retry the task with native tools. If the user fixes the underlying issue and asks again, you delegate again.

## Notes

- altimate-code runs its own LLM, separate from Claude Code's. Costs and rate limits accrue to altimate-code's configured provider.
- Sessions persist in altimate-code's local store — `altimate-code session list` shows prior runs; `--continue` resumes the latest, `--session <id>` resumes a specific one.
- For very long tasks, the `--output` file is the source of truth — stdout buffering can drop content.
