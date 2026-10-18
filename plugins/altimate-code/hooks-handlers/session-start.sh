#!/usr/bin/env bash
# Static SessionStart routing guidance. printf works in sandboxes that
# refuse the temporary files a here-doc can require.

printf '%s\n' '{'
printf '  "hookSpecificOutput": {\n'
printf '    "hookEventName": "SessionStart",\n'
# shellcheck disable=SC2016
printf '    "additionalContext": "altimate-code routing:\\n- Data questions (answers, numbers, lists over warehouses): use the altimate-code MCP tools yourself; they run as altimate-code'"'"'s read-only analyst.\\n- If MCP is unavailable, delegate with `altimate-code run --agent analyst`.\\n- dbt/SQL project edits: delegate with `--agent fast-edit`.\\n- Warehouse-state work (lineage, impact, parity, PII, cost attribution, FinOps, environment diffs): delegate with `--agent builder`.\\n- Say which path was used. The review skill and /review command provide the dbt/SQL PR reviewer."\n'
printf '  }\n'
printf '}\n'
