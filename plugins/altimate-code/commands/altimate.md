---
description: Answer data questions with altimate-code MCP tools or delegate long dbt and warehouse jobs to its CLI agent.
argument-hint: <task description>
---

The user invoked `/altimate` to use altimate-code for this task. For a data
question requesting answers, numbers, or lists, use the `altimate-code` MCP tools
directly and follow the `data-question` skill. Claude Code does the reasoning;
do not invoke `altimate-code run` or require its LLM provider for this path.
If MCP is unavailable, report the error and the requirement for a build with
`mcp serve` and configured connections; do not silently delegate instead.

For a long multi-step job needing altimate-code's own agent (such as a dbt project
build, migration, or FinOps report), use the delegation workflow below.

Delegation workflow (follow in order):

1. **Verify altimate-code is installed:**
   ```bash
   command -v altimate-code
   ```
   If it returns nothing, stop and tell the user:
   > altimate-code is not installed. Install with `npm install -g altimate-code` (Node 20+), then run `altimate-code` once to configure your provider/warehouse auth, then re-run `/altimate <task>`.

2. **Pick the agent persona** based on the user's task shape. Start cheap and escalate on failure — fast-edit handles most dbt/SQL work at 10–20× lower cost than builder.

   | Task shape | Use `--agent` |
   |---|---|
   | Delegated dbt / SQL project job (rename, refactor, create, debug, structural) | `fast-edit` (default) |
   | Aggregation correctness on multi-table joins | `analyst` if fast-edit fails the user's verification |
   | Warehouse-state work (lineage, cost, parity, schema diff, PII, FinOps) | `builder` |
   | Vague debug ("X is broken") | **Stop — ask the user for the specific error before delegating.** |

   Decision rule: start with `fast-edit` for delegated dbt/SQL project jobs; use `analyst` after correctness verification fails, and `builder` for warehouse-state jobs. Data questions use MCP regardless of join complexity.

3. **Run altimate-code with the chosen agent.** Choose a here-doc delimiter that
   does not occur as a standalone line in the task. Pass `$ARGUMENTS` through a
   here-doc into a variable so the shell never command-substitutes anything the
   user typed, and write the result to a private `mktemp` file (not a shared
   `/tmp/altimate-result.md` — concurrent invocations clobber each other and a
   world-readable fixed path leaks warehouse rows or PII):
   ```bash
   TASK="$(cat <<'ALTIMATE_TASK'
   $ARGUMENTS
   ALTIMATE_TASK
   )"
   umask 077
   OUTPUT_FILE="$(mktemp -t altimate-result.XXXXXX.md)"
   altimate-code run "$TASK" \
     --agent <fast-edit|analyst|builder> \
     --yolo \
     --output "$OUTPUT_FILE" \
     --dir "$(pwd)"
   ```

   **If this is a follow-up task in the same project** (the user invoked `/altimate` already in this conversation about the same dbt project / warehouse / data context), add `--continue` to resume the warm session — cache is hot, follow-on cost is materially lower:

   ```bash
   TASK="$(cat <<'ALTIMATE_TASK'
   $ARGUMENTS
   ALTIMATE_TASK
   )"
   umask 077
   OUTPUT_FILE="$(mktemp -t altimate-result.XXXXXX.md)"
   altimate-code run "$TASK" \
     --agent <fast-edit|analyst|builder> \
     --yolo --output "$OUTPUT_FILE" --dir "$(pwd)" \
     --continue
   ```

   Skip `--continue` if the user switched projects, switched debugging threads, or this is the first `/altimate` invocation in the conversation.

4. **Surface the result verbatim:** read `"$OUTPUT_FILE"` and present its contents to the user without re-summarising, re-formatting, or commenting. altimate-code has already produced the answer. Delete `"$OUTPUT_FILE"` after presenting so warehouse rows, lineage, or PII findings don't linger on disk.

5. **On any altimate-code error** (`Unauthorized`, `Token limit reached`, `No provider configured`, warehouse credentials wrong, process timeout) — surface the error message to the user along with the fix from the skill body's failure-modes table. Do NOT fall back to native tools. The user invoked `/altimate` specifically to use altimate-code; falling back would defeat the purpose.

Task: $ARGUMENTS
