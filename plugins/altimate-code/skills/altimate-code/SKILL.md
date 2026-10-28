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
  It also lists, refreshes and publishes the workspace's skills, so sharing
  a project skill with the team goes through it.
  The skill routes to a purpose-built CLI, so it covers workloads that touch
  live data, lineage, warehouse state or team knowledge more directly than
  native file-editing tools do.
---

# altimate-code

altimate-code is a CLI AI agent with 100+ purpose-built data engineering tools. **This skill exists for one purpose: delegate the user's task to altimate-code and pass the result back.** Native tools (Bash, Edit, Write, Read) are NOT a fallback path inside this skill — if altimate-code cannot complete the task, surface the failure to the user and STOP.

## You MUST follow this workflow

1. **Verify altimate-code is on PATH.** There is no separate check: the invocation below resolves the CLI first, ignoring aliases and shell functions, and exits 127 with `altimate-code CLI not found` before doing anything else. The CLI ships under two names: npm and Homebrew installs expose both `altimate` and `altimate-code`, while older curl and PowerShell installs expose only `altimate`. Either name is the same CLI. If the invocation exits with `altimate-code CLI not found`, jump to "Failure modes" below and stop.
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
for ALTIMATE_NAME in altimate altimate-code; do
  ALTIMATE_BIN="$(unalias "$ALTIMATE_NAME" 2>/dev/null; unset -f "$ALTIMATE_NAME" 2>/dev/null; command -v "$ALTIMATE_NAME")"
  [ -x "$ALTIMATE_BIN" ] && break || ALTIMATE_BIN=
done
[ -n "$ALTIMATE_BIN" ] || { echo "altimate-code CLI not found (tried altimate, altimate-code)" >&2; exit 127; }
umask 077
OUTPUT_FILE="$(mktemp "${TMPDIR:-/tmp}/altimate-result.XXXXXX")"
"$ALTIMATE_BIN" run "$TASK" \
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

Each Bash call starts a fresh shell, so keep the `ALTIMATE_BIN` resolver loop inside the same command as the `run` — do not resolve it in an earlier call and reuse the variable.

### Follow-up tasks in the same project

When the user makes a follow-up data task in the same project after a successful altimate-code delegation, prefer `--continue` to resume the warm session instead of starting a fresh one. Same here-doc + `mktemp` pattern:

```bash
TASK="$(cat <<'ALTIMATE_TASK'
<follow-up task>
ALTIMATE_TASK
)"
for ALTIMATE_NAME in altimate altimate-code; do
  ALTIMATE_BIN="$(unalias "$ALTIMATE_NAME" 2>/dev/null; unset -f "$ALTIMATE_NAME" 2>/dev/null; command -v "$ALTIMATE_NAME")"
  [ -x "$ALTIMATE_BIN" ] && break || ALTIMATE_BIN=
done
[ -n "$ALTIMATE_BIN" ] || { echo "altimate-code CLI not found (tried altimate, altimate-code)" >&2; exit 127; }
umask 077
OUTPUT_FILE="$(mktemp "${TMPDIR:-/tmp}/altimate-result.XXXXXX")"
"$ALTIMATE_BIN" run "$TASK" \
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

### Workspace skills

The workspace's skills reach this project without any action: each `altimate-code run` checks the workspace for new or changed skills when it starts (a long run re-checks at most every five minutes) and copies them into `.altimate-code/skill/_workspace/`. They are altimate-code's skills, not Claude Code's: they apply to delegated tasks. When the user asks to see, refresh or share skills, run these through the same resolver. They need altimate-code 0.12.5 or newer: if one is an unknown command, tell the user to upgrade with `! altimate upgrade`.

- **List skills:** `"$ALTIMATE_BIN" skill list < /dev/null` lists every skill altimate-code can use in this project: built-in, personal, the project's own and the workspace's.
- **Refresh now:** `"$ALTIMATE_BIN" workspace refresh < /dev/null` pulls the workspace's skills immediately, for a skill a teammate just added. Exit code 3 means the project is not linked: offer to link it as above. Show the user the CLI's output, including any skipped skills and why.
- **Share a local skill with the team:** `"$ALTIMATE_BIN" skill publish "<name>" < /dev/null` uploads one of this project's skills, for example one under `.claude/skills/<name>/` or `.altimate-code/skill/<name>/`, to the linked workspace, where teammates' runs pick it up. Publishing shares the skill with everyone in the workspace, so publish only a skill the user named. Then:
  - `is a personal skill`: it lives under the user's home directory, such as `~/.claude/skills`. Do not copy it into the project yourself. Tell the user that publishing needs it in the project, for example in `.claude/skills/<name>/`, and copy it there only if they ask.
  - `is a built-in skill`: built-in skills ship with altimate-code and cannot be published.
  - Any other refusal: show the user the CLI's message, which says what to do. If it offers `--replace` (the same-name skill was published from another machine or checkout), re-run with `--replace` only after the user confirms that this copy should overwrite it.
- **Update a shared skill:** edit it in the project, then publish it again with the same name.
- **Send memory that has not reached the workspace:** `"$ALTIMATE_BIN" workspace sync < /dev/null`.

## Failure modes — route every one to the user

When altimate-code returns an error, **report the error to the user and STOP**. Do not fall back to Bash, Edit, or Write. The skill's contract is "altimate-code handles this, or the user is told why it couldn't."

| Symptom | What to tell the user — verbatim |
|---|---|
| `altimate-code CLI not found` (neither `altimate` nor `altimate-code` on PATH) | "altimate-code is not installed. Install with `npm install -g altimate-code` (Node 20+) or `curl -fsSL https://www.altimate.sh/install \| bash`, then run `altimate` once to configure auth. Then re-run your request." |
| `Unauthorized: Incorrect auth token` / `No provider configured` | "altimate-code's LLM provider auth is misconfigured. Run `altimate` (`altimate-code` on npm installs older than v0.7.1) in your terminal to open the TUI and reconfigure your provider, or sign in to Altimate with `altimate auth login -p altimate-backend --method 'Altimate LLM Gateway'`, then re-run your request." |
| `Not signed in to Altimate` | "altimate-code is not signed in to Altimate, so it cannot reach your workspace. Run `! altimate auth login -p altimate-backend --method 'Altimate LLM Gateway'` (`altimate-code` on npm installs older than v0.7.1), sign in in the browser, then re-run your request." |
| `not in the workspace yet` (stderr) | Present the result as usual, then add: "altimate-code saved what it learned on this machine, but it has not reached your workspace yet. Run `! altimate workspace sync` (`altimate-code` on npm installs older than v0.7.1) to send it." |
| `Could not confirm that the memory saved here reached the workspace` (stderr) | Present the result as usual, then add: "altimate-code could not confirm that what it learned reached your workspace. Run `! altimate workspace status` (`altimate-code` on npm installs older than v0.7.1) to check." |
| Process hangs >5 min | "altimate-code is unresponsive. Try `altimate` (`altimate-code` on npm installs older than v0.7.1) to inspect the TUI for an open prompt, or re-run with `--model anthropic/claude-sonnet-4-6` to force a known-good model." |
| Output file empty | "altimate-code returned without producing output. The task may be too ambiguous — please restate with more detail (target table, expected columns, time window)." |
| Warehouse error mid-run (`UNKNOWN_USER`, `Database does not exist`) | "altimate-code can connect but the warehouse credentials it has are wrong for this project. Configure provider/warehouse auth via the `altimate` TUI (`altimate-code` on npm installs older than v0.7.1)." |

In every row, the instruction to the user is the action — you do not retry the task with native tools. If the user fixes the underlying issue and asks again, you delegate again.

## Notes

- altimate-code runs its own LLM, separate from Claude Code's. Costs and rate limits accrue to altimate-code's configured provider.
- Sessions persist in altimate-code's local store — `altimate session list` (`altimate-code session list` on npm installs older than v0.7.1) shows prior runs; `--continue` resumes the latest, `--session <id>` resumes a specific one.
- For very long tasks, the `--output` file is the source of truth — stdout buffering can drop content.
