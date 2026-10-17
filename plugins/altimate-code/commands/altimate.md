---
description: Prefer altimate-code MCP for data questions; delegate when unavailable and for other dbt and warehouse jobs.
argument-hint: <task description>
---

The user invoked `/altimate` to use altimate-code for this task. For a data
question requesting answers, numbers, or lists, prefer the `altimate-code` MCP
tools when available in the session and follow the `data-question` skill.
Claude Code does the reasoning; this path needs no CLI LLM provider. If the tools
are unavailable (server missing or failed to start), use the delegation workflow
below with `--agent analyst`. Released builds without `mcp serve` can still
delegate. Tell the user which path is being used and, for fallback, that MCP is
unavailable and delegation uses the CLI's separate configured LLM provider.

For a long multi-step job needing altimate-code's own agent (such as a dbt project
build, migration, or FinOps report), or a capability outside the five MCP tools
listed in the `altimate-code` skill, use the delegation workflow below. Tell the
user that CLI delegation is being used.

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
   | Data question when MCP tools are unavailable | `analyst` |
   | Delegated dbt / SQL project job (rename, refactor, create, debug, structural) | `fast-edit` (default) |
   | Aggregation correctness on multi-table joins | `analyst` if fast-edit fails the user's verification |
   | Warehouse-state work (lineage, cost, parity, schema diff, PII, FinOps) | `builder` |
   | Vague debug ("X is broken") | **Stop — ask the user for the specific error before delegating.** |

   Decision rule: use `analyst` for data questions when MCP tools are unavailable; otherwise prefer MCP regardless of join complexity. Start with `fast-edit` for delegated dbt/SQL project jobs; use `analyst` after correctness verification fails, and `builder` for warehouse-state jobs.

3. **Run altimate-code with the chosen agent.** Generate a fresh delimiter per
   call, such as `ALTIMATE_TASK_<random hex>`, and check that it does not occur as
   a standalone line in the complete task. Regenerate it if it does. Replace both
   occurrences of `ALTIMATE_TASK_<random hex>` in each template below with that
   checked delimiter; keep the opening delimiter single-quoted (no shell
   expansion). Insert the actual `$ARGUMENTS` text verbatim into the body before
   execution. Pass it through a
   here-doc into a variable so the shell never command-substitutes anything the
   user typed, and write the result to a private `mktemp` file (not a shared
   `/tmp/altimate-result.md` — concurrent invocations clobber each other and a
   world-readable fixed path leaks warehouse rows or PII):
   ```bash
   TASK="$(cat <<'ALTIMATE_TASK_<random hex>'
   $ARGUMENTS
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

   **If this is a follow-up task in the same project** (the user invoked `/altimate` already in this conversation about the same dbt project / warehouse / data context), add `--continue` to resume the warm session — cache is hot, follow-on cost is materially lower:

   ```bash
   TASK="$(cat <<'ALTIMATE_TASK_<random hex>'
   $ARGUMENTS
   ALTIMATE_TASK_<random hex>
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
