#!/usr/bin/env bash
# Static SessionStart capability description. printf works in sandboxes that
# refuse the temporary files a here-doc can require.

printf '%s\n' '{'
printf '  "hookSpecificOutput": {\n'
printf '    "hookEventName": "SessionStart",\n'
printf '    "additionalContext": "The altimate-code plugin provides MCP data tools for warehouse questions: Claude Code reasons directly with warehouse_list, schema_inspect, sql_execute, sql_check, and sql_materialize. The data-question skill covers this workflow. The altimate-code routing skill delegates long jobs such as dbt builds, migrations, and FinOps reports to the CLI agent. The review skill and /review command provide the specialized dbt/SQL PR reviewer."\n'
printf '  }\n'
printf '}\n'
