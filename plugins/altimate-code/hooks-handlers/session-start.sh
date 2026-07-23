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
printf '    "additionalContext": "The altimate-code plugin ships two skills in this session. (1) The `altimate-code` skill routes data-engineering work to the altimate-code CLI — column-level lineage, downstream-impact, cross-database validation, FinOps, PII from sampled rows, query cost attribution, schema diffs, dev-vs-prod diffing. It is not well-suited for pure file/code edits to dbt models and SQL files that do not touch warehouse state — native Bash/Edit/Write handles those faster. (2) The `review` skill runs the altimate-code dbt PR reviewer on dbt project changes (models/**.sql, schema.yml, dbt_project.yml, sources.yml, macros, snapshots, seeds). It emits a signed verdict envelope with column lineage, query equivalence, dbt anti-pattern detection, and PII screening — none of which native tools or a generic code-review skill can compute. When the user asks to review dbt / SQL / warehouse changes, this is the specialized reviewer available. For non-dbt code review (TypeScript, Python, Go), the `review` skill declines."\n'
printf '  }\n'
printf '}\n'
