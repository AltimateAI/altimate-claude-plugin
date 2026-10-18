---
description: Delegate a task to altimate-code, the specialised data-engineering CLI agent (warehouse access, column-level lineage, cross-DB, FinOps, query optimization, your Altimate workspace's skills and knowledge)
argument-hint: <task description>
---

The user explicitly invoked `/altimate-code:altimate` to delegate this task to altimate-code. You MUST run the task via the `altimate-code` CLI — do NOT attempt the work with native `Bash`/`Edit`/`Write` tools, and do not read the project's files first: altimate-code investigates the project itself.

Workflow (follow in order, no skipping):

1. **Verify altimate-code is installed:**
   ```bash
   command -v altimate-code
   ```
   If it returns nothing, stop and tell the user:
   > altimate-code is not installed. Install with `npm install -g altimate-code` (Node 20+), then run `altimate-code` once to configure your provider/warehouse auth, then re-run `/altimate-code:altimate <task>`.

2. **Vague debug** ("X is broken") with no failure named: **stop — ask the user for the specific error before delegating.**

3. **Run altimate-code with the `builder` agent**, which has the warehouse tools, workspace skills and memory. Pass `$ARGUMENTS` through a
   here-doc into a variable so the shell never command-substitutes anything the
   user typed, write the result to a private `mktemp` file (not a shared
   `/tmp/altimate-result.md` — concurrent invocations clobber each other and a
   world-readable fixed path leaks warehouse rows or PII), and redirect stdin
   from `/dev/null` (`altimate-code run` reads piped stdin as part of the task,
   and this shell leaves stdin open):
   ```bash
   TASK="$(cat <<'ALTIMATE_TASK'
   $ARGUMENTS
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

   **If this is a follow-up task in the same project** (the user invoked `/altimate-code:altimate` already in this conversation about the same dbt project / warehouse / data context), add `--continue` to resume the warm session — cache is hot, follow-on cost is materially lower:

   ```bash
   TASK="$(cat <<'ALTIMATE_TASK'
   $ARGUMENTS
   ALTIMATE_TASK
   )"
   umask 077
   OUTPUT_FILE="$(mktemp "${TMPDIR:-/tmp}/altimate-result.XXXXXX")"
   altimate-code run "$TASK" \
     --agent builder \
     --yolo --output "$OUTPUT_FILE" --dir "$(pwd)" \
     --continue \
     < /dev/null
   ```

   Skip `--continue` if the user switched projects, switched debugging threads, or this is the first `/altimate-code:altimate` invocation in the conversation.

   If the project is linked to an Altimate workspace, altimate-code uses its skills, knowledge and memory automatically. There is nothing to pass.

4. **Surface the result verbatim:** read `"$OUTPUT_FILE"` and present its contents to the user without re-summarising, re-formatting, or commenting. altimate-code has already produced the answer. Delete `"$OUTPUT_FILE"` after presenting so warehouse rows, lineage, or PII findings don't linger on disk.

5. **On any altimate-code error** (`Unauthorized`, `Token limit reached`, `No provider configured`, `Not signed in to Altimate`, warehouse credentials wrong, process timeout) — surface the error message to the user along with the fix from the skill body's failure-modes table. Do NOT fall back to native tools. The user invoked `/altimate-code:altimate` specifically to use altimate-code; falling back would defeat the purpose.

Task to delegate: $ARGUMENTS
