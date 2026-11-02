"""Opt-in PreToolUse guard for Bash, run by warehouse-guard.sh when ALTIMATE_ROUTE_GUARD=1.

Denies commands that query a warehouse directly through a client (psql -c, mysql -e,
trino --execute, clickhouse-client --query, snowsql -q, sqlcmd -Q, duckdb <db> "<sql>",
bq query, SQL piped or redirected into a client) and points at `altimate tool run`.

The command is split into words the way the shell quotes them, so quoted text (commit
messages, echo arguments, JSON) is never taken for a command. Each simple command is
judged after its prefixes: shell keywords, VAR=value, sudo/env/command/time/exec/nice/
nohup/timeout and docker/podman/docker-compose/kubectl exec, each with the options it
takes. A bash/sh/zsh/dash/ksh -c string, an env -S string and every $(...) or `...`
substitution are judged as commands of their own. Newlines separate commands, as in the
shell. A heredoc body is data: it is not judged, except for the substitutions in the body
of an unquoted delimiter, which the shell runs. Commands handed to another program as
arguments (ssh, watch, xargs) are not judged. Any parsing problem results in allow: this
is a routing nudge, not a security control.
"""

import json
import os
import re
import shlex
import sys

HINT = (
    "Direct warehouse query detected. The altimate-code CLI runs this read-only with no extra setup: "
    "altimate tool run sql_execute --workspace-tools --args with a JSON body holding the warehouse and "
    "query fields --json (schema_inspect for structure, warehouse_list for connections). "
    "Use altimate-code if altimate is not on PATH."
)
SEPARATORS = set(";&|()")
# Separators inside quotes or escaped are words, not operators: masked before splitting.
MASK = {ord(c): 0xE000 + n for n, c in enumerate(";&|()")}
UNMASK = {v: k for k, v in MASK.items()}
PLACEHOLDER = "\ue005"  # stands in for a substitution, which is judged on its own
HEREDOC = re.compile(r"<<(-?)[ \t]*((?:[^\s;&|()<>'\"\\]|'[^']*'|\"[^\"]*\"|\\.)+)")
KEYWORDS = {"then", "do", "else", "elif", "if", "while", "until", "{", "!"}
ASSIGN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=")
# Options that take a separate value: (short letters, long names). Any other option takes none.
WRAPPERS = {
    "sudo": ("CDghpRrTUu", {"user", "group", "chdir", "close-from", "host", "prompt", "role", "type", "other-user", "command-timeout", "chroot"}),
    "env": ("uCS", {"unset", "chdir", "split-string"}),
    "command": ("", set()),
    "time": ("fo", {"format", "output"}),
    "exec": ("a", set()),
    "nice": ("n", {"adjustment"}),
    "nohup": ("", set()),
    "timeout": ("sk", {"signal", "kill-after"}),
}
DOCKER = ("cHl", {"context", "host", "config", "log-level", "connection", "url", "identity"})
COMPOSE = ("fp", {"file", "project-name", "project-directory", "env-file", "profile", "ansi", "parallel"})
EXEC = ("euw", {"env", "user", "workdir", "env-file", "detach-keys", "index"})
KUBECTL = ("ncfs", {"namespace", "container", "filename", "context", "kubeconfig", "cluster", "user", "server", "pod-running-timeout", "as", "token", "request-timeout"})
SHELL = ("oO", {"rcfile", "init-file"})
SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}
# Query flags per client, matched against a whole word.
QUERY_FLAGS = {
    "psql": r"-[AaEeHLlnqStXx]*[cf].*|--command(=.*)?|--file(=.*)?",
    "mysql": r"-e.*|--execute(=.*)?",
    "trino": r"-f.*|--execute(=.*)?|--file(=.*)?",
    "clickhouse": r"-q.*|--query(=.*)?|--queries-file(=.*)?",
    "clickhouse-client": r"-q.*|--query(=.*)?|--queries-file(=.*)?",
    "snowsql": r"-q.*|-f.*|--query(=.*)?|--filename(=.*)?",
    "sqlcmd": r"-Q.*|-q.*|-i.*",
    "duckdb": r"-c|-s|-cmd",
}
QUERY_INPUT = re.compile(r"(<<|<\s*\S+\.sql)")
DUCKDB_VALUED = {"-init", "-separator", "-newline", "-nullvalue", "-cmd"}


def skip_options(words, i, spec, dash_dash=True):
    """Index of the first word at or after i that is not an option or an option's value."""
    short, long = spec
    while i < len(words):
        word = words[i]
        if word == "--" and dash_dash:
            return i + 1
        if word.startswith("--") and len(word) > 2:
            i += 2 if "=" not in word and word[2:] in long else 1
        elif len(word) > 1 and word[0] in "-+" and not word[1:].isdigit() or re.fullmatch(r"-\d+", word):
            takes = next((j for j, c in enumerate(word[1:], 1) if c in short), None)
            i += 2 if takes == len(word) - 1 else 1  # the value is attached unless the letter ends the word
        else:
            return i
    return i


def scan(text, i=0, nested=False):
    """(text with quoted and escaped separators masked, substitutions replaced by a placeholder,
    newlines turned into ; and heredoc bodies dropped; the substitution bodies; the index just
    past the closing parenthesis when nested inside $( )). Quotes inside a substitution are its
    own; a heredoc body is data, so only an unquoted delimiter's body has substitutions."""
    out, subs, quote, depth, heredocs = [], [], None, 0, []
    while i < len(text):
        c = text[i]
        if c == "\\" and quote != "'" and i + 1 < len(text):
            if text[i + 1] != "\n":  # a backslash-newline joins the lines
                out.append(c + text[i + 1].translate(MASK))
            i += 2
        elif quote != "'" and (text.startswith("$(", i) or c == "`"):
            i = substitution(text, i, subs)
            out.append(PLACEHOLDER)
        elif quote:
            quote = None if c == quote else quote
            out.append(c if quote is None else c.translate(MASK))
            i += 1
        elif c in "'\"":
            quote = c
            out.append(c)
            i += 1
        elif nested and c in "()" and (depth := depth + (1 if c == "(" else -1)) < 0:
            return "".join(out), subs, i + 1
        elif (heredoc := HEREDOC.match(text, i)) and not text.startswith("<<<", i):
            word = heredoc.group(2)
            delimiter = re.sub(r"[\"'\\]", "", word)
            heredocs.append((delimiter, delimiter != word, heredoc.group(1) == "-"))
            out.append("<<" + PLACEHOLDER)  # the << stays visible to the query-input check
            i = heredoc.end()
        elif c == "\n":
            out.append(";")  # newlines separate commands, as in the shell
            i += 1
            for delimiter, quoted, strip_tabs in heredocs:
                while i < len(text):
                    end = text.find("\n", i)
                    end = len(text) if end < 0 else end
                    line, i = text[i:end], end + 1
                    if (line.lstrip("\t") if strip_tabs else line) == delimiter:
                        break
                    k = 0
                    while not quoted and k < len(line):
                        k = substitution(line, k, subs) if line.startswith("$(", k) or line[k] == "`" else k + 1
            heredocs = []
        elif c == "#" and (i == 0 or text[i - 1] in " \t;&|()"):
            # A comment runs to the end of the line; the newline still separates.
            end = text.find("\n", i)
            i = len(text) if end < 0 else end
        else:
            out.append(c)
            i += 1
    return "".join(out), subs, i


def substitution(text, i, subs):
    """Records the body of the $(...) or `...` at i; returns the index just past it."""
    if text[i] == "`":
        j = i + 1
        while j < len(text) and text[j] != "`":
            j += 2 if text[j] == "\\" else 1
        subs.append(text[i + 1 : j])
        return min(j + 1, len(text))
    j = scan(text, i + 2, nested=True)[2]
    subs.append(text[i + 2 : j - 1])
    return j


def simple_commands(text):
    """(words, piped) per simple command of text that scan() prepared."""
    lexer = shlex.shlex(text, posix=True, punctuation_chars=";&|()")
    lexer.whitespace_split = True
    lexer.commenters = ""
    words, piped = [], False
    for token in lexer:
        if token and set(token) <= SEPARATORS:
            if words:
                yield words, piped
            words, piped = [], token.lstrip(")") in ("|", "|&")
        else:
            words.append(token.translate(UNMASK))
    if words:
        yield words, piped


def is_query(name, args):
    if name == "bq":  # the subcommand: the first word that is not an option (or may be a --flag's value)
        for k, arg in enumerate(args):
            if arg == "query":
                return True
            if not arg.startswith("-") and not (k and args[k - 1].startswith("--") and "=" not in args[k - 1]):
                return False
        return False
    if any(re.fullmatch(QUERY_FLAGS[name], a) for a in args) or QUERY_INPUT.search(" ".join(args)):
        return True
    if name == "duckdb":  # duckdb [options] <database> "<sql>"
        operands = [a for k, a in enumerate(args) if not a.startswith("-") and not (k and args[k - 1] in DUCKDB_VALUED)]
        return len(operands) >= 2
    return False


def judge(text, depth=0):
    if depth > 5:
        return False
    masked, subs, _ = scan(text)
    if any(judge(body, depth + 1) for body in subs):
        return True
    try:
        commands = list(simple_commands(masked))
    except ValueError:  # unbalanced quotes: not a command this can judge
        return False
    for words, piped in commands:
        i = 0
        while i < len(words):
            name = os.path.basename(words[i])
            if words[i] in KEYWORDS or ASSIGN.match(words[i]):
                i += 1
            elif name in WRAPPERS:
                if name == "env":  # env -S "<command line>" runs the split string
                    for k, word in enumerate(words[i + 1 : skip_options(words, i + 1, WRAPPERS["env"])], i + 1):
                        split = word[2:] if word.startswith("-S") and len(word) > 2 else word.partition("=")[2] if word.startswith("--split-string=") else None
                        if split is None and word in ("-S", "--split-string") and k + 1 < len(words):
                            split = words[k + 1]
                        if split and judge(split, depth + 1):
                            return True
                i = skip_options(words, i + 1, WRAPPERS[name])
                if name == "timeout" and i < len(words):
                    i += 1  # the duration
            elif name in ("docker", "podman", "docker-compose"):
                if name != "docker-compose":
                    i = skip_options(words, i + 1, DOCKER, dash_dash=False)
                    if i < len(words) and words[i] == "compose":
                        i = skip_options(words, i + 1, COMPOSE, dash_dash=False)
                else:
                    i = skip_options(words, i + 1, COMPOSE, dash_dash=False)
                if i >= len(words) or words[i] != "exec":
                    break
                i = skip_options(words, i + 1, EXEC) + 1  # past the container
            elif name == "kubectl":
                i = skip_options(words, i + 1, KUBECTL, dash_dash=False)
                if i >= len(words) or words[i] != "exec":
                    break
                i = skip_options(words, skip_options(words, i + 1, KUBECTL, dash_dash=False) + 1, KUBECTL)
            elif name in SHELLS:
                flags = words[i + 1 : skip_options(words, i + 1, SHELL)]
                script = skip_options(words, i + 1, SHELL)
                if any(f.startswith("-") and not f.startswith("--") and "c" in f for f in flags) and script < len(words):
                    if judge(words[script], depth + 1):
                        return True
                break
            else:
                if name in QUERY_FLAGS or name == "bq":
                    if (piped and name != "bq") or is_query(name, words[i + 1 :]):
                        return True
                break
    return False


def main():
    try:
        command = (json.load(sys.stdin).get("tool_input") or {}).get("command", "")
    except Exception:
        return
    if not isinstance(command, str) or not command:
        return
    # A lone altimate CLI command is always allowed; one chained with other commands or
    # running a command or process substitution is judged like any other command.
    if not re.search(r"[;&|`\n]|\$\(|<\(|>\(", command) and re.match(
        r'(/\S*/)?(altimate|altimate-code) |"\$ALTIMATE_BIN" ', command
    ):
        return
    if judge(command):
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": HINT}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:  # a parsing problem allows the command
        pass
