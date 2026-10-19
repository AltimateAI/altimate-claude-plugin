#!/usr/bin/env bash
# Checks the CLI resolver block embedded in the skills and slash commands:
# every copy must be identical, and it must pick the right binary in bash and zsh.
set -u
cd "$(dirname "$0")/.."

# file:expected number of resolver blocks
FILES=(
  plugins/altimate-code/commands/altimate.md:2
  plugins/altimate-code/commands/review.md:1
  plugins/altimate-code/skills/altimate-code/SKILL.md:2
  plugins/altimate-code/skills/review/SKILL.md:1
)
FAILURES=0
fail() { echo "FAIL: $*"; FAILURES=$((FAILURES + 1)); }

# Print each resolver block (loop start through the not-found guard) on one line, dedented.
extract_blocks() {
  awk '/for ALTIMATE_NAME in/ {grab=1; block=""}
       grab {sub(/^ */, ""); block = block $0 "\\n"}
       grab && /CLI not found/ {grab=0; print block}' "$1"
}

ALL_BLOCKS=""
for entry in "${FILES[@]}"; do
  file="${entry%:*}"
  blocks="$(extract_blocks "$file")"
  count="$(printf '%s' "$blocks" | grep -c .)"
  [ "$count" -eq "${entry##*:}" ] || fail "$file has $count resolver blocks, expected ${entry##*:}"
  ALL_BLOCKS="$ALL_BLOCKS$blocks"$'\n'
done
[ "$(printf '%s' "$ALL_BLOCKS" | grep . | sort -u | grep -c .)" -eq 1 ] || fail "resolver blocks differ between files"
RESOLVER="$(printf '%b' "$(printf '%s' "$ALL_BLOCKS" | head -n1)")"

STUBS="$(mktemp -d)"
trap 'rm -rf "$STUBS"' EXIT
for stub in only-altimate/altimate only-altimate-code/altimate-code both/altimate both/altimate-code "relative dir/altimate"; do
  mkdir -p "$STUBS/$(dirname "$stub")"
  printf '#!/bin/sh\necho "ran %s"\n' "$(basename "$stub")" > "$STUBS/$stub"
  chmod +x "$STUBS/$stub"
done
mkdir -p "$STUBS/neither"

# expect <shell> <PATH prefix> <setup> <expected exit> <expected output>
# Runs from $STUBS without startup files, so relative PATH entries resolve and user config can't interfere.
expect() {
  local shell_cmd
  case "$1" in zsh) shell_cmd=(zsh -f) ;; *) shell_cmd=(bash --noprofile --norc) ;; esac
  out="$(cd "$STUBS" && env -u BASH_ENV -u ENV PATH="$2:/usr/bin:/bin" "${shell_cmd[@]}" -c "$3
$RESOLVER
\"\$ALTIMATE_BIN\"" 2>&1)"
  status=$?
  [ "$status" -eq "$4" ] && [ "$out" = "$5" ] \
    || fail "$1 / PATH=$2 / '${3:-no setup}': expected exit $4 '$5', got exit $status '$out'"
}

ALIAS_SETUP='shopt -s expand_aliases 2>/dev/null; alias altimate-code=altimate'
for sh in bash zsh; do
  command -v "$sh" >/dev/null || { echo "skip: $sh not installed"; continue; }
  expect "$sh" "$STUBS/only-altimate" '' 0 'ran altimate'
  expect "$sh" "$STUBS/only-altimate-code" '' 0 'ran altimate-code'
  expect "$sh" "$STUBS/both" '' 0 'ran altimate'
  expect "$sh" "$STUBS/neither" '' 127 'altimate-code CLI not found (tried altimate, altimate-code)'
  expect "$sh" "$STUBS/only-altimate" "$ALIAS_SETUP" 0 'ran altimate'
  expect "$sh" "$STUBS/only-altimate" "$ALIAS_SETUP; altimate() { echo function; }" 0 'ran altimate'
  expect "$sh" "$STUBS/only-altimate" 'altimate-code() { echo function; }' 0 'ran altimate'
  expect "$sh" "$STUBS/only-altimate-code" 'shopt -s expand_aliases 2>/dev/null; alias altimate=altimate-code' 0 'ran altimate-code'
  expect "$sh" "relative dir" '' 0 'ran altimate'
done

[ "$FAILURES" -eq 0 ] && echo "ok" || { echo "$FAILURES failure(s)"; exit 1; }
