#!/usr/bin/env bash
# SessionStart hook for the altimate-code plugin. Emits a descriptive statement
# of the altimate-code skill's capabilities so Claude can route to it when the
# task shape fits. Deliberately descriptive rather than imperative — see the
# Claude plugin review-criteria checklist items on "avoid instructing Claude
# to call other tools" and "don't interfere with tool sequencing."
#
# Uses printf (not a here-doc) so the hook works in restricted sandboxes that
# refuse to create the temporary file a here-doc needs.

printf '%s\n' '{'
printf '  "hookSpecificOutput": {\n'
printf '    "hookEventName": "SessionStart",\n'
printf '    "additionalContext": "The altimate-code skill is available in this session. It routes tasks to the altimate-code CLI, a specialised data-engineering agent with warehouse access, column-level lineage, cross-database validation, FinOps reporting, PII detection, and profile-driven query optimization. It is well-suited for tasks that require inspecting live warehouse state: column lineage, downstream-impact analysis, cross-database migration or validation, query-cost attribution against a real warehouse, schema diffs between environments, data parity checking, PII detection from sampled rows, FinOps reporting, or dev-vs-prod diffing. It is not well-suited for pure file or code edits to dbt models and SQL files that do not touch warehouse state — for those, Claude'"'"'s native Bash, Edit, and Write tools are faster and cheaper because altimate-code'"'"'s discovery loop (project scan, schema index, warehouse listing) is overkill for file-only work."\n'
printf '  }\n'
printf '}\n'
