#!/usr/bin/env bash
set -e
git init -q .
mkdir -p .claude/skills/staging-conventions
printf -- '---\nname: staging-conventions\ndescription: How we name and test staging models.\n---\nPrefix staging models with stg_.\n' > .claude/skills/staging-conventions/SKILL.md
