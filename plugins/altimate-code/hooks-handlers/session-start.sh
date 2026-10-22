#!/usr/bin/env bash
# Static SessionStart routing guidance. printf works in sandboxes that
# refuse the temporary files a here-doc can require.

printf '%s\n' '{'
printf '  "hookSpecificOutput": {\n'
printf '    "hookEventName": "SessionStart",\n'
# shellcheck disable=SC2016
printf '    "additionalContext": "altimate-code: use its MCP tools directly for data and available workspace context, knowledge and skills. When Altimate data mode is ON, keep reasoning in Claude, report missing capabilities, and leave memory saving to the user via /altimate-remember. Outside that mode, the altimate-code skill covers CLI delegation for long jobs and unavailable capabilities; delegation uses a separate model and may save shared memory. /review handles dbt/SQL PRs."\n'
printf '  }\n'
printf '}\n'
