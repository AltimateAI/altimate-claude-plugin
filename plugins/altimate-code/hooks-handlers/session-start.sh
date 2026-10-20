#!/usr/bin/env bash
# Static SessionStart routing guidance. printf works in sandboxes that
# refuse the temporary files a here-doc can require.

printf '%s\n' '{'
printf '  "hookSpecificOutput": {\n'
printf '    "hookEventName": "SessionStart",\n'
# shellcheck disable=SC2016
printf '    "additionalContext": "altimate-code: answer data questions with its MCP tools yourself; for dbt/SQL edits, warehouse-state jobs or when MCP is unavailable, delegate with `altimate-code run` (altimate-code skill; /review for dbt/SQL PRs)."\n'
printf '  }\n'
printf '}\n'
