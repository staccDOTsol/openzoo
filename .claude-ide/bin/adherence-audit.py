#!/usr/bin/env python3
"""
Adherence-audit Stop hook — auto-installed by Claude IDE.

Scores each session's tool discipline so harness tuning has a baseline
instead of anecdotes: counts indexed-navigation calls (MCP find_definition /
search_code / get_section / find_file / read_exact / read_wiki) vs the
unguided habits they should replace (Grep-tool identifier searches, shell
grep/rg for identifiers, whole-file Reads with no offset/limit). Appends one
JSON line per Stop to .claude-ide/adherence-log.jsonl (last line per session
id wins — counts are cumulative over the transcript).

Read the scoreboard:
  python3 - <<'EOF'
import json,collections
rows={}
for l in open('.claude-ide/adherence-log.jsonl'):
    r=json.loads(l); rows[r['session']]=r
tot=collections.Counter()
for r in rows.values(): tot.update(r['counts'])
print(dict(tot))
EOF

Fail-open by design: any internal error exits 0.
"""
import json, os, sys

NL = chr(10)
MAX_BYTES = 80 * 1024 * 1024

def is_ident(s):
    return isinstance(s, str) and s.isidentifier() and len(s) >= 4

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not isinstance(data, dict):
    sys.exit(0)
tp = str(data.get("transcript_path") or "")
session = str(data.get("session_id") or "unknown")
project = str(data.get("cwd") or os.getcwd())
if not tp or not os.path.isfile(tp):
    sys.exit(0)
try:
    if os.path.getsize(tp) > MAX_BYTES:
        sys.exit(0)
except OSError:
    sys.exit(0)

MCP_NAV = ("find_definition", "find_references", "search_code",
           "get_section", "find_file", "read_exact")
counts = {"mcp_nav": 0, "wiki_reads": 0, "grep_ident": 0,
          "bash_grep_ident": 0, "read_nolimit": 0, "read_bounded": 0,
          "index_shell": 0,
          "tasks": 0}  # Harness v7: process discipline (TaskCreate/Update/…)

# Index-backed shell navigation is GUIDED, not a bypass. The bin/ helpers and
# a grep of repo-index.txt read the same index the MCP tools do — and they are
# what the guard's own denial text recommends first, so scoring them as
# unguided both slandered compliance and hid whether that advice was working.
INDEX_HELPERS = ("bin/find-def", "bin/who-calls", "bin/resolve-path")
INDEX_FILES = (".claude-ide/repo-index", "xref-defs", "xref-callers",
               ".claude-ide/paths.txt", ".claude/wiki.md")
READ_VERBS = ("grep", "egrep", "rg", "awk", "sed", "head", "tail", "cat", "wc")


def bash_uses_index(cmd):
    """True when a Bash call NAVIGATES via the index rather than raw source."""
    if any(h in cmd for h in INDEX_HELPERS):
        return True
    if any(p in cmd for p in INDEX_FILES):
        return any(v in cmd for v in READ_VERBS)  # reads only, not the writer
    return False

def bash_has_ident_grep(cmd):
    # Cheap token scan: a grep/egrep/rg word followed later by a bare
    # identifier positional. Approximate on purpose — this is a metric,
    # not a guard.
    toks = cmd.replace('"', " ").replace("'", " ").split()
    seen = False
    for t in toks:
        base = t.rsplit("/", 1)[-1]
        if base in ("grep", "egrep", "fgrep", "rg"):
            seen = True
            continue
        if seen and not t.startswith("-") and is_ident(t):
            return True
        if t in ("|", "&&", ";"):
            seen = False
    return False

try:
    with open(tp, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except Exception:
                continue
            msg = rec.get("message") if isinstance(rec, dict) else None
            content = msg.get("content") if isinstance(msg, dict) else None
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                name = str(block.get("name") or "")
                inp = block.get("input") or {}
                if not isinstance(inp, dict):
                    inp = {}
                short = name.rsplit("__", 1)[-1]
                if short in ("TaskCreate", "TaskUpdate", "TaskGet", "TaskList"):
                    counts["tasks"] += 1  # separate from guided/unguided nav
                if short in MCP_NAV and "claude-ide" in name:
                    counts["mcp_nav"] += 1
                elif short == "read_wiki" and "claude-ide" in name:
                    counts["wiki_reads"] += 1
                elif name == "Grep" and is_ident(str(inp.get("pattern") or "")):
                    counts["grep_ident"] += 1
                elif name == "Bash" and bash_uses_index(str(inp.get("command") or "")):
                    counts["index_shell"] += 1  # checked BEFORE the grep test
                elif name == "Bash" and bash_has_ident_grep(str(inp.get("command") or "")):
                    counts["bash_grep_ident"] += 1
                elif name == "Read":
                    if inp.get("limit") or inp.get("offset"):
                        counts["read_bounded"] += 1
                    else:
                        counts["read_nolimit"] += 1
except OSError:
    sys.exit(0)

guided = (counts["mcp_nav"] + counts["wiki_reads"] + counts["read_bounded"]
          + counts["index_shell"])
unguided = counts["grep_ident"] + counts["bash_grep_ident"] + counts["read_nolimit"]
total = guided + unguided
row = {
    "session": session,
    "ts": int(__import__("time").time()),
    "counts": counts,
    "guided_pct": round(100.0 * guided / total, 1) if total else None,
}
try:
    out = os.path.join(project, ".claude-ide", "adherence-log.jsonl")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "a", encoding="utf-8") as f:
        f.write(json.dumps(row) + NL)
except Exception:
    pass
sys.exit(0)
