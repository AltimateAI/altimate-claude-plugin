---
name: altimate-code
description: >-
  Delegate long dbt and warehouse jobs to the altimate-code CLI (builds, migrations, FinOps, lineage, impact, schema diff, parity, PII, cost, SCD2 checks, docs, env diffs), or data questions when its MCP tools are unavailable.
---

# altimate-code

Choose the path from the requested outcome, including when invoked via `/altimate`.

## Data questions: prefer MCP tools, otherwise delegate

For answers, numbers, or lists over warehouse data, use the `altimate-code` MCP
server yourself when its tools are available in the session; the server's
instructions give the analysis method. The tools are
`warehouse_list`, `warehouse_add`, `sql_execute` (with `tables` for schemas), `sql_materialize`, and `answer_commit`.
Claude Code does the reasoning; this server runs no LLM and needs no separate
LLM-provider configuration. Tell the user that the MCP path is being used.

The server is read-only by default for source databases. Postgres, SQLite, and
DuckDB enforce read-only access at the database level; other databases rely on
SQL classification, so use a read-only DB user. `sql_materialize` writes only to
session-local `scratch` DuckDB for analysis. Large query results may spill to a
local file path; read the needed results there before answering.

If the MCP tools are unavailable in the session (server missing or failed to
start), tell the user that MCP is unavailable and that you are using CLI
delegation with its separate configured LLM provider. Follow the invocation
workflow below with `--agent analyst`. Released altimate-code builds without
`mcp serve` can still use this delegation path. If an available tool fails,
report that error; do not invent results. Use native file-reading tools as needed
to read local result files.

## Other capabilities and long jobs: delegate to the CLI agent

Use `altimate-code run` for long multi-step jobs needing its own agent, such as
building a dbt project, migrations, or a FinOps report. Also delegate capabilities
outside the five MCP tools: column-level lineage, downstream impact, schema diff,
data parity, PII detection, query cost attribution, query optimization,
incremental/SCD2 verification, model docs, and dev-vs-prod diffs. Tell the user
that CLI delegation is being used. First check
`command -v altimate-code`. Pass the user's task verbatim using the safe
invocation below, then read and present the output. Delegation uses
altimate-code's own configured LLM provider, costs, and rate limits.

## Invocation — pick the right agent for the task

altimate-code has multiple agent personas. The default (`builder`) does a full project discovery sweep on every call — fine for warehouse-state work but ~10–20× more expensive than necessary on simple file edits. **Pick the agent based on task shape before invoking.**

### Step 1 — classify the task

| Shape | Examples | Use |
|---|---|---|
| **Data question when MCP tools are unavailable** | answers, numbers, lists, including multi-table aggregations | `analyst` |
| **Delegated dbt / SQL job** (rename, refactor, create model, debug, structural reorg, multi-step setup) | long project jobs needing the CLI agent | `fast-edit` — try this first |
| **Multi-table aggregation correctness** | new model joining 3+ tables with `count(*)` / `sum() over (...)` / "first X, last X" logic that must be exactly right | `analyst` if `fast-edit` fails the user's verification |
| **Warehouse-state work** | column-level lineage, downstream-impact, cross-DB migration / parity, query cost attribution against a real warehouse, schema diff between environments, PII detection, FinOps reporting | `builder` (default — has warehouse tools enabled) |
| **Vague debug** ("X is broken", "make it work", "fix this") | unspecified failure mode | **Don't delegate yet.** Ask the user for the specific error message or symptom before invoking any agent — empirically all three agents fail vague debug prompts at ~700K tokens each. |

**Decision policy (delegation only):** use `analyst` for data questions when MCP tools are unavailable; otherwise prefer MCP for data questions, including multi-table aggregations. Start with `fast-edit` for dbt/SQL project jobs. If the user reports the result is wrong (e.g. aggregation values don't match), retry with `analyst`. Only use `builder` when the task genuinely needs the warehouse-investigation tools (it's 10–20× more expensive than fast-edit and rarely required).

### Step 2 — invoke with the chosen agent

Generate a fresh delimiter per call, such as `ALTIMATE_TASK_<random hex>`, and
check that it does not occur as a standalone line in the complete task. Regenerate
it if it does. Replace both occurrences of `ALTIMATE_TASK_<random hex>` in each
template below with that checked delimiter; keep the opening delimiter
single-quoted (no shell expansion). Pass the task through a quoted here-doc into a variable so the shell never
command-substitutes anything the user typed (a task like
`refactor `whoami` and $(rm -rf ~)` would otherwise fire `whoami` and
`rm -rf ~` before `altimate-code` ever runs). Write the result to a
private temporary file, not a shared one under `/tmp`:

```bash
TASK="$(cat <<'ALTIMATE_TASK_<random hex>'
<user's task, verbatim>
ALTIMATE_TASK_<random hex>
)"
umask 077
OUTPUT_FILE="$(mktemp -t altimate-result.XXXXXX.md)"
altimate-code run "$TASK" \
  --agent <fast-edit|analyst|builder> \
  --yolo \
  --output "$OUTPUT_FILE" \
  --dir "$(pwd)"
```

Then `Read "$OUTPUT_FILE"` and emit its contents to the user without re-summarising, re-formatting, or commenting on the result. altimate-code has already produced the answer. Delete `"$OUTPUT_FILE"` after presenting so warehouse rows, lineage, or PII findings don't linger on disk.

### Required flags

| Flag | Why it is required |
|---|---|
| `--agent <name>` | Picks the agent persona. Default `builder` is overkill for simple edits — see the classification table above. Wrong agent = either 10× too expensive (using `builder` on a rename) or wrong-answer (using `fast-edit` on a multi-table join). |
| `--yolo` | Non-interactive mode. Without this the subprocess hangs on the first permission prompt and you will time out. |
| `--output "$OUTPUT_FILE"` | Captures the final response. Use the private `mktemp` file from above — do NOT use a fixed path like `/tmp/altimate-result.md`; concurrent sessions clobber each other and a world-readable fixed path leaks data. |
| `--dir "$(pwd)"` | Runs altimate-code in the current project so it picks up dbt project config, profiles.yml, etc. |

### Follow-up tasks in the same project

When the user makes a follow-up data task in the same project after a successful altimate-code delegation, prefer `--continue` to resume the warm session instead of starting a fresh one. Same here-doc + `mktemp` pattern:

```bash
TASK="$(cat <<'ALTIMATE_TASK_<random hex>'
<follow-up task>
ALTIMATE_TASK_<random hex>
)"
umask 077
OUTPUT_FILE="$(mktemp -t altimate-result.XXXXXX.md)"
altimate-code run "$TASK" \
  --agent <fast-edit|analyst|builder> \
  --yolo \
  --output "$OUTPUT_FILE" \
  --dir "$(pwd)" \
  --continue   # resumes the most recent session in this dir
```

altimate-code's prompt cache is warm in a continued session — project structure, profiles.yml, schema index, source definitions don't need to be re-investigated. Cache reads are billed at a fraction of fresh input on altimate-gateway. The downside is zero: if there's no useful cached context for the new task, you pay normal cold cost.

If the user starts a clearly unrelated workflow (different project, different schema, different debugging thread), drop `--continue` and start fresh — the warm cache is irrelevant and you'd carry unrelated history into the prompt.

## Delegation failures

If `altimate-code run` fails, report the error and stop that delegation; do not
silently replace it with native edits or warehouse commands.

| Symptom | Action to tell the user |
|---|---|
| CLI not on PATH | Install an altimate-code build appropriate for this plugin, then retry. MCP requires a build with `mcp serve`. |
| `Unauthorized: Incorrect auth token` / `No provider configured` | Run `altimate-code` in a terminal and configure its LLM provider, then retry the delegated job. MCP data questions do not require this provider. |
| Process hangs >5 min | Open the altimate-code TUI to check for a pending prompt. |
| Output file empty | Report the missing output; ask for the target, expected result, or time window if the task is ambiguous. |
| Warehouse error (`UNKNOWN_USER`, `Database does not exist`) | Check the project's warehouse connection configuration and database access. |

## Delegation notes

- Sessions persist locally: `altimate-code session list` lists prior runs;
  `--continue` resumes the latest, `--session <id>` a specific session.
- For very long tasks, the private `--output` file is the source of truth;
  stdout buffering can drop content.
