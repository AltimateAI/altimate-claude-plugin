---
description: Use altimate-code for this task. Data questions go through its MCP tools or `tool run` CLI, long dbt and warehouse jobs are delegated to its agent.
argument-hint: <task description>
---

The user explicitly invoked `/altimate-code:altimate` to use altimate-code for this task. Two paths exist, chosen by what the task and the session offer:

- **Data question** (answers, numbers, lists over warehouse data, lineage, impact, PII, diffs): when tools named `mcp__plugin_altimate-code_altimate-code__*` are available in the session, answer with them yourself and follow the server's analysis method. When they are not available (an organisation's managed settings disallow MCP servers, or the server failed to start), delegate with `--agent analyst` as in the workflow below. The `altimate-code` skill's `tool run` path also works for a single analysis. Tell the user which path is being used.
- **Altimate workspace question** (team conventions, definitions, knowledge, workspace skills or memory, a query on a workspace warehouse integration): answer it yourself with `workspace_context`, `workspace_skill` and `workspace_execute`, the MCP tools when present and otherwise `tool run <name> --workspace-tools`, as the `altimate-code` skill's "Altimate workspaces" section describes. Delegate with `builder` only when the CLI has neither (too old for `--workspace-tools`).
- **Long multi-step job** (dbt build, migration, FinOps report): delegate with the `builder` agent as in the workflow below. Delegation uses the CLI's own LLM provider.

For delegation you MUST run the task via the `altimate-code` CLI — do NOT attempt the work with native `Bash`/`Edit`/`Write` tools, and do not read the project's files first: altimate-code investigates the project itself.

Delegation workflow (follow in order, no skipping):

1. **Verify altimate-code is installed.** There is no separate check: the run command in step 3 resolves the CLI first, ignoring aliases and shell functions, and exits 127 with `altimate-code CLI not found` before doing anything else. The CLI ships under two names: npm and Homebrew installs expose both `altimate` and `altimate-code`, while older curl and PowerShell installs expose only `altimate`. Either one is fine. If the run exits with `altimate-code CLI not found`, stop and tell the user:
   > altimate-code is not installed. Install with `npm install -g altimate-code` (Node 20+) or `curl -fsSL https://www.altimate.sh/install | bash`, then run `altimate` once to configure your provider/warehouse auth, then re-run `/altimate-code:altimate <task>`.

2. **Vague debug** ("X is broken") with no failure named: **stop — ask the user for the specific error before delegating.**

3. **Run altimate-code with the chosen agent** (`analyst` for a data question when MCP tools are unavailable, otherwise `builder`), which has the warehouse tools, workspace skills and memory. Pass `$ARGUMENTS` through a
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
   TASK="$(cat <<'ALTIMATE_TASK'
   $ARGUMENTS
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
