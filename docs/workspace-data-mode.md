# Automatic workspace workflow: controlled pilot

Status: draft, unpublished. Product PRs remain drafts; merging does not publish an artifact, update the default plugin, or establish production success.

## Behavior changes

| Trigger / surface | Previous prototype | Automatic pilot |
| --- | --- | --- |
| Default marketplace listing | Prototype replaced its MCP registration | Original directory and listing restored to their main bytes (7c9b1da8d2014d786a152bf6dbb43f8237d1588a) |
| Experimental install | User supplied a compatible CLI on PATH | Platform package embeds a verified local CLI build |
| Relevant data prompt | User enabled data mode | Claude selects a semantic data skill; no activation command |
| Ordinary coding prompt | Enabled mode read workspace context every prompt | No per-prompt workspace reads or prompt rewriting |
| Workspace not configured | Manual commands and reconnect | Status-driven setup panel; explicit sign-in/link/install actions; same MCP connection |
| Completed SQL | User opened results pane | Non-focused results pane opens automatically; dismissal respected |
| Workspace conventions | Potential legacy agent delegation | Native workspace context/skill/knowledge tools; Claude retains reasoning |
| Memory publication | Explicit command after inspection | Explicit inspected form or user-only command; receipt-bound, no automatic retry |
| Workspace engine permissions | Separate discovered host tools | One `workspace_execute` host tool, with a closed read allowlist and schema checks |

The plugin PR targets main directly and does not require merging the older default-plugin toolkit experiment. The split is deliberate: Claude UI/routing belong in this repo; reusable identity, context, setup status, skills and engine gateway belong in altimate-code. The gateway has a stable catalog before and after setup. Context is lazy, coalesced and cached for 30 seconds with identity verification; engine startup happens only when requested. A changed receipt invalidates old operations.

## Package and install

Build the compatible altimate-code checkout using its documented single-target build. The build emits `bin/altimate-code` and adjacent `build-inputs.json`. Then:

```
python3 scripts/package-experimental.py \
  --core /absolute/path/to/altimate-code-checkout \
  --binary /absolute/path/to/target/bin/altimate-code \
  --output /absolute/path/to/new-pilot-directory
```

The packager verifies source hashes, added build inputs and CLI capabilities; copies the unmodified MCP registration and a compatible executable; records target, binary hash, source commits and dirty-state flags; and creates a zip. It never downloads `latest`, installs globally, publishes or updates the default listing. Dirty artifacts are development previews; a release artifact must be rebuilt from reviewed commits. Build and verify each supported platform separately.

Unzip the prepared platform artifact. In Claude Code, add the extracted directory as a marketplace, then install `altimate-code-experimental@altimate-experimental-pilot`. Disable the original plugin through Claude's plugin UI first. Enabling both is unsupported because skill and tool routing overlap; installation of both is allowed, simultaneous activation is not. No mode, workspace or pane command is needed in daily use. Below 144 terminal columns Claude hides unrequested panes; a button above the prompt opens results/setup with a click. This band yields to surveys and preserves existing band content.

The Git marketplace's experimental source entry lacks its runtime until a compatible artifact is published. Do not announce it as a working public installation. To release the pilot, first deliver compatible core capabilities, then prepare clean platform artifacts, verify fresh installations and publish those explicitly to pilot users. Promoting it to default is a later decision.

## Verification and limits

The automatic implementation adds event/UI tests for setup statuses, explicit actions, continuation, cancelled/obsolete conversations, actual SQL observation, dismissal, UI failures, explicit memory destination, coexistence detection and terminal/Desktop/VS Code handlers. Core tests exercise a real stdio engine fixture through the stable adapter, including unlinked-to-linked transition, engine installation refresh, receipt changes and concurrent context loading. Fixtures establish protocol behavior, not production warehouse success.

The earlier manual-prototype live demo and six-run comparison are historical evidence only; see `data-workspace-experiment.md`. Those runs did not establish cost or latency savings. The runtime installs in an isolated Claude configuration and passes unchanged-registration MCP/SQLite execution without a compatible CLI on PATH. Real Claude terminal testing caught and fixed a skill/command naming collision. Automatic panes are hidden by Claude below 144 columns; a clickable band opens results or setup without commands. Natural-prompt execution and setup continuation still need live model capacity before pilot readiness. Current Claude account probes return “session limit”; live automatic demo/comparison remain blocked pending renewed capacity. No substitute mock result is labelled live E2E.

Before rollout, verify sign-in/setup continuation in a fresh real Claude install, a real read-only workspace warehouse query, Desktop/VS Code painting and enterprise mod policy. No production binding or memory publication has been performed for this change.
