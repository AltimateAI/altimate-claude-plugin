---
description: Review the team rules proposed from your corrections in a project linked to an Altimate workspace, and see the workspace's team rules and the review status of your proposals
---

The user invoked `/altimate-code:rules`. In a project linked to an Altimate workspace, altimate-code proposes a team rule when the user corrects the agent on the same topic in two sessions, corrects a team rule the session was given, or asks to remember something as a team rule. Those proposals wait here for the user's answer. Nothing reaches teammates until the workspace owner approves it.

Workflow (follow in order):

1. **List them.** Run this, which resolves the CLI first, ignoring aliases and shell functions:
   ```bash
   for ALTIMATE_NAME in altimate altimate-code; do
     ALTIMATE_BIN="$(unalias "$ALTIMATE_NAME" 2>/dev/null; unset -f "$ALTIMATE_NAME" 2>/dev/null; command -v "$ALTIMATE_NAME")"
     [ -x "$ALTIMATE_BIN" ] && break || ALTIMATE_BIN=
   done
   [ -n "$ALTIMATE_BIN" ] || { echo "altimate-code CLI not found (tried altimate, altimate-code)" >&2; exit 127; }
   "$ALTIMATE_BIN" learn proposals --json < /dev/null
   ```
   - Exit 127 (`altimate-code CLI not found`): tell the user to install it (`npm install -g altimate-code`) and stop.
   - An error saying `proposals` is an unknown command: tell the user to update altimate-code (`npm install -g altimate-code@latest`) and stop.

2. **Show the state.** The JSON has `workspace` (`name`, `owner_name`, `is_owner`; `null` when the project is not linked), `proposals`, `team_rules` and `mine`. Show, briefly:
   - the number of team rules in the workspace, and their texts when there are 10 or fewer;
   - the user's own proposals in `mine` that are not yet active, with their `status` and, for a rejected one, the `reason`;
   - then each entry in `proposals`, one at a time, as described in step 3.

   If `proposals` is empty, say that no proposed rules are waiting and stop.

3. **Ask about each proposal.** For each one show its `text`, what it changes (`change`: `add`, `edit` showing `replaces.text` as the current rule, or `retire`), `why`, the user's correction (`evidence.correction.excerpt`) when present, and `applies_to` when not empty. If `weakens_verification` is set, say so plainly: the rule would weaken verification (tests, CI, hooks). Then ask the user with the AskUserQuestion tool, offering only the proposal's `actions`, labelled:
   - `send` → "Send for review" (to `workspace.owner_name`'s review queue)
   - `approve` → "Approve now" (the user is the workspace owner)
   - `edit` → "Edit wording"
   - `save_memory` → "Save as memory" (offered when the wording did not say rule or memory)
   - `save_local` → "Save for this project only" (the project is not linked)
   - `dismiss` → "Not a rule" (that topic is not proposed again for 30 days)
   - and always "Decide later" (do nothing; it stays waiting).

4. **Answer through the CLI.** Map the choice to one flag: `--send`, `--approve`, `--edit`, `--memory`, `--local` or `--dismiss`. For "Edit wording", ask for the new wording (one line, at most 140 characters). Pass it through a here-doc so the shell never interprets what the user typed:
   ```bash
   for ALTIMATE_NAME in altimate altimate-code; do
     ALTIMATE_BIN="$(unalias "$ALTIMATE_NAME" 2>/dev/null; unset -f "$ALTIMATE_NAME" 2>/dev/null; command -v "$ALTIMATE_NAME")"
     [ -x "$ALTIMATE_BIN" ] && break || ALTIMATE_BIN=
   done
   [ -n "$ALTIMATE_BIN" ] || { echo "altimate-code CLI not found (tried altimate, altimate-code)" >&2; exit 127; }
   PROPOSAL_ID='<the proposal id>'
   WORDING="$(cat <<'ALTIMATE_RULE'
   <the new wording>
   ALTIMATE_RULE
   )"
   "$ALTIMATE_BIN" learn proposals reply "$PROPOSAL_ID" --json --edit="$WORDING" < /dev/null
   ```
   Keep `--edit="$WORDING"` in one argument (a wording that starts with `-` is otherwise read as a flag), and start the closing `ALTIMATE_RULE` line at the beginning of its line. For any other choice, run the same command with that flag instead of `--edit="$WORDING"` (and without the here-doc).

   The JSON answer is `{"ok": true, "message": …, "closed": …}` or `{"ok": false, "code": …, "error": …}`. Show the `message` or `error` to the user as it is. Then:
   - `closed: false` after an edit: the proposal is still open with the new wording; ask about it again.
   - `verification_flagged`: the rule weakens verification. Ask the user to confirm explicitly. Only if they confirm, reply with `--approve-anyway`.
   - `invalid_text`: the wording was refused; ask for another wording.
   - `refused`: the workspace refused the content; offer to edit it.
   - `busy`: another session is answering it; skip it for now.
   - `not_open`: it was already answered or closed; move on.
   - `not_available` saying it "was being answered with" another action: an earlier answer stopped part-way; offer to finish it with that action.

5. **Finish** with one line on what was sent, approved, saved or dismissed, and how many proposals are still waiting. Do not change any project files.
