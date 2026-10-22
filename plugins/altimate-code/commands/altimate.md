---
description: Prefer altimate-code MCP for data questions; delegate when unavailable and for other dbt, warehouse and Altimate workspace jobs.
argument-hint: <task description>
---

The user invoked `/altimate-code:altimate` to use altimate-code for this task. For a data
question requesting answers, numbers, or lists, prefer the `altimate-code` MCP
tools when available in the session and follow the server's analysis method.
If the current prompt says Altimate data mode is ON, follow the skill's native-data-mode rules: use available MCP tools, report missing capabilities, and keep memory saving under the user's `/altimate-remember` command. The delegation workflow below applies only outside that mode. Workspace knowledge uses `workspace_context`, `workspace_ask_knowledge_base` and `workspace_skill` when available.
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

1. **Verify altimate-code is installed.** There is no separate check: the run command in step 3 resolves the CLI first, ignoring aliases and shell functions, and exits 127 with `altimate-code CLI not found` before doing anything else. The CLI ships under two names: npm and Homebrew installs expose both `altimate` and `altimate-code`, while older curl and PowerShell installs expose only `altimate`. Either one is fine. If the run exits with `altimate-code CLI not found`, stop and tell the user:
   > altimate-code is not installed. Install with `npm install -g altimate-code` (Node 20+) or `curl -fsSL https://www.altimate.sh/install | bash`, then run `altimate` once to configure your provider/warehouse auth, then re-run `/altimate-code:altimate <task>`.

2. **Vague debug** ("X is broken") with no failure named: **stop — ask the user for the specific error before delegating.**

   Use `--agent analyst` for a data question when MCP tools are unavailable; otherwise use `--agent builder`, which has the warehouse tools, workspace skills and memory.

3. **Run altimate-code with the chosen agent.** Generate a fresh delimiter per
   call, such as `ALTIMATE_TASK_<random hex>`, and check that it does not occur as
   a standalone line in the complete task. Regenerate it if it does. Replace both
   occurrences of `ALTIMATE_TASK_<random hex>` in each template below with that
   checked delimiter; keep the opening delimiter single-quoted (no shell
   expansion). Insert the actual `$ARGUMENTS` text verbatim into the body before
   execution. Pass it through a
   here-doc into a variable so the shell never command-substitutes anything the
   user typed, write the result to a private `mktemp` file (not a shared
   `/tmp/altimate-result.md` — concurrent invocations clobber each other and a
   world-readable fixed path leaks warehouse rows or PII), and redirect stdin
   from `/dev/null` (`altimate-code run` reads piped stdin as part of the task,
   and this shell leaves stdin open):
   ```bash
   TASK="$(cat <<'ALTIMATE_TASK_<random hex>'
   $ARGUMENTS
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

   **If this is a follow-up task in the same project** (the user invoked `/altimate-code:altimate` already in this conversation about the same dbt project / warehouse / data context), add `--continue` to resume the warm session — cache is hot, follow-on cost is materially lower:

   ```bash
   TASK="$(cat <<'ALTIMATE_TASK_<random hex>'
   $ARGUMENTS
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
     --yolo --output "$OUTPUT_FILE" --dir "$(pwd)" \
     --continue \
     < /dev/null
   ```

   Skip `--continue` if the user switched projects, switched debugging threads, or this is the first `/altimate-code:altimate` invocation in the conversation.

   If the project is linked to an Altimate workspace, altimate-code uses its skills, knowledge and memory automatically. There is nothing to pass.

4. **Surface the result verbatim:** read `"$OUTPUT_FILE"` and present its contents to the user without re-summarising, re-formatting, or commenting. altimate-code has already produced the answer. Delete `"$OUTPUT_FILE"` after presenting so warehouse rows, lineage, or PII findings don't linger on disk. If the command's stderr says `not in the workspace yet` or `Could not confirm that the memory saved here reached the workspace`, add the matching note from the skill body's failure-modes table after the result.

5. **On any altimate-code error** (`Unauthorized`, `Token limit reached`, `No provider configured`, `Not signed in to Altimate`, warehouse credentials wrong, process timeout) — surface the error message to the user along with the fix from the skill body's failure-modes table. Do NOT fall back to native tools. The user invoked `/altimate-code:altimate` specifically to use altimate-code; falling back would defeat the purpose.

Task: $ARGUMENTS
