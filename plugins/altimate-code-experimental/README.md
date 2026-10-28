# Altimate Code Experimental

Ask data questions naturally in Claude Code. Claude uses Altimate's native data tools, loads workspace conventions when relevant, and opens SQL results automatically. No data-mode, workspace-picker or pane-opening command is needed for ordinary use.

This is an unpublished pilot. The Git source listing alone is **not installable**: it requires a compatible bundled CLI in `runtime/altimate-code`. Use a platform-specific package produced by `scripts/package-experimental.py`. No compatible public CLI version or public pilot artifact is promised by this draft.

## Install the prepared pilot

Unzip the platform-specific pilot, then in Claude Code:

```
/plugin marketplace add /absolute/path/to/unpacked-pilot
/plugin install altimate-code-experimental@altimate-experimental-pilot
```

Use Claude Code 2.1.307, the tested mods API version. Disable the original `altimate-code` listing in Claude's plugin UI before enabling this one; simultaneous activation is unsupported. The experimental observer refuses calls when it detects both tool namespaces. The original listing and its distribution remain unchanged.

The package includes a self-contained CLI; you do not need to install a second compatible CLI on PATH. Select the package for your OS and architecture. The current local build targets macOS Apple Silicon; other platforms need their own build and verification.

## Use it

Ask, for example, “What is our convention for recognizing recurring revenue?” or “Show monthly revenue from this SQLite database.” Claude chooses the data skill when relevant. Ordinary coding prompts do not trigger a workspace read. Local files and configured local SQL connections do not require Altimate sign-in.

When a workspace question needs setup, the panel offers **Sign in**, workspace selection, or **Install workspace engine** as needed. Sign-in opens the native browser flow. Workspace selection links this project without uploading existing memory. Successful setup queues continuation of the pending question if you have not cleared the conversation or asked another question. “Not now” dismisses setup. Warehouse engine installation uses the native npm installer and requires Node.js 20+ and npm; it runs only after that explicit action.

Workspace tools stay available in the same MCP session after linking. Context is fetched on demand and cached for up to 30 seconds; account/project/workspace receipts are checked before reuse and execution. Setup continuation explicitly refreshes context and engine discovery.

SQL results open in a non-focused pane. Claude hides unrequested panes below 144 terminal columns; a “View SQL results” or “Continue Altimate setup” button above the prompt opens them with a click. Closing it suppresses automatic reopening for the conversation. Optional `/altimate-mode off` stops automatic presentation; `/altimate-mode on` restores it. This is presentation, not an authorization boundary. `/altimate-data` opens the results pane and `/altimate-query` runs an explicit SQL command through Claude's normal tool permission flow.

## Memory, permissions and cost

No automatic memory publication occurs. Explicit `/altimate-workspace` inspection shows the destination and a save form; `/altimate-remember <id> <text>` is an optional user-only shortcut after that inspection. Saving affects exactly the supplied project memory block. An uncertain cloud publication is reported without retry.

Claude supplies reasoning; this integration does not launch another Altimate reasoning agent. Local SQL makes no separate model calls. Workspace knowledge requests and memory publication can invoke backend models, and warehouse queries retain warehouse costs. No cost or latency improvement is established for this automatic flow.

Workspace operations use one host permission surface, `workspace_execute`. Granting that tool allows its read-operation allowlist, including knowledge requests; it does not preserve separate host approvals for each engine operation. The server validates the current workspace receipt, actual engine input schema and read-only SQL classification. Use read-only warehouse credentials. No memory-write engine tool is exposed.

Terminal, Desktop and VS Code UI handlers are covered by the mod test kit. Real terminal startup, SQL and setup painting have been exercised. Natural-prompt execution and setup continuation still require model capacity; the local account currently reports its session quota exhausted. See [the rollout and verification notes](../../docs/workspace-data-mode.md).
