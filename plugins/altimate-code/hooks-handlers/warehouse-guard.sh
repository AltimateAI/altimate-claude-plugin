#!/usr/bin/env bash
# Opt-in PreToolUse hook for Bash. Does nothing unless ALTIMATE_ROUTE_GUARD=1; then
# warehouse-guard.py judges the command (see its docstring). Without python3 every
# command is allowed: this is a routing nudge, not a security control.

[ "${ALTIMATE_ROUTE_GUARD:-}" = "1" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0
exec python3 -I "$(dirname "$0")/warehouse-guard.py"
