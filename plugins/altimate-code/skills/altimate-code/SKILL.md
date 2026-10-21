---
name: altimate-code
description: >-
  Delegate long dbt and warehouse jobs to the altimate-code CLI (builds, migrations, FinOps, lineage, impact, schema diff, parity, PII, cost, SCD2 checks, docs, env diffs), questions about the team's Altimate workspace knowledge and conventions, or data questions when its MCP tools are unavailable.
---

# altimate-code

Choose the path from the requested outcome, including when invoked via `/altimate-code:altimate`.

## Data questions: prefer MCP tools, otherwise delegate

For answers, numbers, or lists over warehouse data, use the `altimate-code` MCP
server yourself when its tools are available in the session; the server's
instructions give the analysis method. The tools are
`warehouse_list`, `warehouse_add`, `sql_execute` (with `tables` for schemas), `sql_materialize`, and `answer_commit` (optional).
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
incremental/SCD2 verification, model docs, and dev-vs-prod diffs. Questions about
the team's own conventions, standards, knowledge or shared memory, and anything the
user calls their Altimate workspace, also belong to the CLI: in a project linked to
an Altimate workspace it answers from that workspace's skills, knowledge and memory,
which native tools cannot read. Tell the user that CLI delegation is being used.
Pass the user's task verbatim using the safe invocation below, then read and
present the output. Delegation uses altimate-code's own configured LLM provider,
costs, and rate limits.

## Invocation

There is no separate install check: the invocation below resolves the CLI first, ignoring aliases and shell functions, and exits 127 with `altimate-code CLI not found` before doing anything else. The CLI ships under two names: npm and Homebrew installs expose both `altimate` and `altimate-code`, while older curl and PowerShell installs expose only `altimate`. Either name is the same CLI. If the invocation exits with `altimate-code CLI not found`, jump to "Failure modes" below and stop.

**Vague debug** ("X is broken", "make it work", "fix this") with no failure named: **don't delegate yet.** Ask the user for the specific error message or symptom first.

Pick the agent: `analyst` for a data question when the MCP tools are unavailable; otherwise `builder`, which has the warehouse tools, loads the linked workspace's skills and saves to its memory.

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
for ALTIMATE_NAME in altimate altimate-code; do
  ALTIMATE_BIN="$(unalias "$ALTIMATE_NAME" 2>/dev/null; unset -f "$ALTIMATE_NAME" 2>/dev/null; command -v "$ALTIMATE_NAME")"
  [ -x "$ALTIMATE_BIN" ] && break || ALTIMATE_BIN=
done
[ -n "$ALTIMATE_BIN" ] || { echo "altimate-code CLI not found (tried altimate, altimate-code)" >&2; exit 127; }
umask 077
OUTPUT_FILE="$(mktemp "${TMPDIR:-/tmp}/altimate-result.XXXXXX")"
"$ALTIMATE_BIN" run "$TASK" \
  --agent <analyst|builder> \
  --yolo \
  --output "$OUTPUT_FILE" \
  --dir "$(pwd)" \
  < /dev/null
```

Then `Read "$OUTPUT_FILE"` and emit its contents to the user without re-summarising, re-formatting, or commenting on the result. altimate-code has already produced the answer. Delete `"$OUTPUT_FILE"` after presenting so warehouse rows, lineage, or PII findings don't linger on disk.

### Required flags

| Flag | Why it is required |
|---|---|
| `--agent <name>` | `analyst` for the MCP-unavailable data-question fallback, `builder` for everything else (it has the warehouse tools, workspace skills and memory). |
| `--yolo` | Non-interactive mode. Without this the subprocess hangs on the first permission prompt and you will time out. |
| `--output "$OUTPUT_FILE"` | Captures the final response. Use the private `mktemp` file from above — do NOT use a fixed path like `/tmp/altimate-result.md`; concurrent sessions clobber each other and a world-readable fixed path leaks data. |
| `--dir "$(pwd)"` | Runs altimate-code in the current project so it picks up dbt project config, profiles.yml, the linked workspace, etc. |
| `< /dev/null` | `altimate-code run` reads piped stdin as part of the task. The shell this runs in leaves stdin open, so without the redirect the run waits for input that never comes. |

Each Bash call starts a fresh shell, so keep the `ALTIMATE_BIN` resolver loop inside the same command as the `run` — do not resolve it in an earlier call and reuse the variable.

### Follow-up tasks in the same project

When the user makes a follow-up data task in the same project after a successful altimate-code delegation, prefer `--continue` to resume the warm session instead of starting a fresh one. Same here-doc + `mktemp` pattern:

```bash
TASK="$(cat <<'ALTIMATE_TASK_<random hex>'
<follow-up task>
ALTIMATE_TASK_<random hex>
)"
for ALTIMATE_NAME in altimate altimate-code; do
  ALTIMATE_BIN="$(unalias "$ALTIMATE_NAME" 2>/dev/null; unset -f "$ALTIMATE_NAME" 2>/dev/null; command -v "$ALTIMATE_NAME")"
  [ -x "$ALTIMATE_BIN" ] && break || ALTIMATE_BIN=
done
[ -n "$ALTIMATE_BIN" ] || { echo "altimate-code CLI not found (tried altimate, altimate-code)" >&2; exit 127; }
umask 077
OUTPUT_FILE="$(mktemp "${TMPDIR:-/tmp}/altimate-result.XXXXXX")"
"$ALTIMATE_BIN" run "$TASK" \
  --agent <analyst|builder> \
  --yolo \
  --output "$OUTPUT_FILE" \
  --dir "$(pwd)" \
  --continue \
  < /dev/null
```

`--continue` resumes the most recent session in this directory. altimate-code's prompt cache is warm in a continued session — project structure, profiles.yml, schema index, source definitions don't need to be re-investigated. If the user starts a clearly unrelated workflow (different project, different schema, different debugging thread), drop `--continue` and start fresh.

## Altimate workspaces

A project can be linked to an Altimate workspace: the team's shared skills, knowledge, memory and warehouse integrations. Every `altimate-code run` in a linked project uses that workspace automatically — there is nothing to pass. That is why questions about the team's conventions, standards or knowledge belong to this skill.

When the user asks about their workspace or wants to set one up, run each command below through the same resolver as the `run`, in the same Bash call:

```bash
for ALTIMATE_NAME in altimate altimate-code; do
  ALTIMATE_BIN="$(unalias "$ALTIMATE_NAME" 2>/dev/null; unset -f "$ALTIMATE_NAME" 2>/dev/null; command -v "$ALTIMATE_NAME")"
  [ -x "$ALTIMATE_BIN" ] && break || ALTIMATE_BIN=
done
[ -n "$ALTIMATE_BIN" ] || { echo "altimate-code CLI not found (tried altimate, altimate-code)" >&2; exit 127; }
"$ALTIMATE_BIN" <workspace or link command from the list below> < /dev/null
```

Commands the user types after `!` use `altimate`; on npm installs older than v0.7.1 the user types `altimate-code` instead.

- **Check the link:** `"$ALTIMATE_BIN" workspace status < /dev/null`. Exit code 0 means linked and 3 means not linked. Exit code 2 with `Not signed in to Altimate` means the user must sign in. For anything else, show the user the CLI's message.
- **Not signed in:** tell the user to run `! altimate auth login -p altimate-backend --method "Altimate LLM Gateway"` in this session. It opens their browser to sign in. Do not try to sign in for them. Keep the `--method` flag: without it the command waits at a menu that cannot be answered from this session.
- **Not linked:** do not suggest `! altimate link`: its picker needs a terminal, and this session does not give it one. Instead run `"$ALTIMATE_BIN" workspace list < /dev/null`, show the user the workspaces it prints, and once they choose, run `"$ALTIMATE_BIN" link --workspace "<id or name>" < /dev/null`. If they want a new workspace, run `"$ALTIMATE_BIN" link --create < /dev/null`, which names it after the repository. If a workspace with that name already exists, `--create` refuses and names it: offer to link to that one with `--workspace`, or, if the user confirms they want a second one, re-run with `--allow-duplicate`. If the project is already linked to a different workspace, `link` refuses; confirm the move with the user, then re-run it with `--yes`. If `workspace list` is an unknown command (an older altimate-code), ask the user for the workspace's name, or tell them to run `altimate link` in a separate terminal.
- **Open it in the browser:** `"$ALTIMATE_BIN" workspace status` prints the workspace page's URL.

What altimate-code learns during delegated tasks is saved to the workspace's memory and shared with the team in the CLI, the IDE and Studio.

## Failure modes

If `altimate-code run` fails, report the error and stop that delegation; do not
silently replace it with native edits or warehouse commands.

| Symptom | What to tell the user |
|---|---|
| `altimate-code CLI not found` (neither `altimate` nor `altimate-code` on PATH; MCP tools additionally need a build with `mcp serve`) | "altimate-code is not installed. Install with `npm install -g altimate-code` (Node 20+) or `curl -fsSL https://www.altimate.sh/install \| bash`, then run `altimate` once to configure auth. Then re-run your request." |
| `Unauthorized: Incorrect auth token` / `No provider configured` | "altimate-code's LLM provider auth is misconfigured. Run `altimate` (`altimate-code` on npm installs older than v0.7.1) in your terminal to open the TUI and reconfigure your provider, or sign in to Altimate with `altimate auth login -p altimate-backend --method 'Altimate LLM Gateway'`, then re-run your request." |
| `Not signed in to Altimate` | "altimate-code is not signed in to Altimate, so it cannot reach your workspace. Run `! altimate auth login -p altimate-backend --method 'Altimate LLM Gateway'` (`altimate-code` on npm installs older than v0.7.1), sign in in the browser, then re-run your request." |
| `not in the workspace yet` (stderr) | Present the result as usual, then add: "altimate-code saved what it learned on this machine, but it has not reached your workspace yet. Run `! altimate workspace sync` (`altimate-code` on npm installs older than v0.7.1) to send it." |
| `Could not confirm that the memory saved here reached the workspace` (stderr) | Present the result as usual, then add: "altimate-code could not confirm that what it learned reached your workspace. Run `! altimate workspace status` (`altimate-code` on npm installs older than v0.7.1) to check." |
| Process hangs >5 min | "altimate-code is unresponsive. Try `altimate` (`altimate-code` on npm installs older than v0.7.1) to inspect the TUI for an open prompt, or re-run with `--model anthropic/claude-sonnet-4-6` to force a known-good model." |
| Output file empty | "altimate-code returned without producing output. The task may be too ambiguous — please restate with more detail (target table, expected columns, time window)." |
| Warehouse error mid-run (`UNKNOWN_USER`, `Database does not exist`) | "altimate-code can connect but the warehouse credentials it has are wrong for this project. Configure provider/warehouse auth via the `altimate` TUI (`altimate-code` on npm installs older than v0.7.1)." |


In every row, the instruction to the user is the action — you do not retry the task with native tools. MCP data questions do not need the CLI's LLM provider.

## Delegation notes

- Sessions persist locally: `altimate session list` (`altimate-code session list` on npm installs older than v0.7.1) lists prior runs; `--continue` resumes the latest, `--session <id>` a specific session.
- For very long tasks, the private `--output` file is the source of truth; stdout buffering can drop content.
