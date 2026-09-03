#!/usr/bin/env python3
"""
Read-guard PreToolUse hook — auto-installed by Claude IDE.

Blocks a whole-file Read of a large, indexed source file with feedback
steering to the claude-ide MCP nav tools (get_section / find_definition /
list_symbols) or a targeted offset/limit Read. Rationale mirrors grep-guard:
the model's trained default for "understand this file" is to Read it whole,
and CLAUDE.md instructions decay across a long context — only a PreToolUse
hook reliably flips that default so the structured tools actually get used.

Conservative — only blocks when ALL of:
  - it's a Read with NO offset and NO limit (a deliberate whole-file read)
  - the path is a code source file (not md/txt/json/config/lock/images)
  - the file is in the repo index AND spans >= THRESHOLD lines
Escape hatches: re-Read with an explicit offset/limit (auto-allowed), an
IDENTICAL whole-file retry (denied once with the section map, then allowed —
the write-guard/bash-guard approval contract; sometimes the task genuinely
needs the whole file, e.g. a full-architecture review), or the file is
non-code / small / un-indexed. To disable: remove the PreToolUse/Read
entry from .claude/settings.json (Hooks editor in the IDE).
"""
import hashlib, json, os, re, sys, tempfile, time

THRESHOLD = 600  # lines; aligns with CLAUDE.md ">500 lines: never Read whole"
APPROVAL_TTL = 24 * 3600
STATE_MAX = 300

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not isinstance(data, dict):
    sys.exit(0)

ti = data.get("tool_input") or {}
path = str(ti.get("file_path") or "")
if not path:
    sys.exit(0)
# Already reading a slice — exactly the behavior we want. Allow.
if ti.get("offset") is not None or ti.get("limit") is not None:
    sys.exit(0)

CODE_RE = re.compile(
    r"\.(js|mjs|cjs|jsx|ts|tsx|rs|py|go|java|c|cc|cpp|h|hpp|cs|rb|php|swift|kt|scala|vue|svelte|astro)$",
    re.IGNORECASE)
if not CODE_RE.search(path):
    sys.exit(0)

project = str(data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or "")
index = os.path.join(project, ".claude-ide", "repo-index.txt") if project else ""
if not index or not os.path.isfile(index):
    sys.exit(0)

rel = path[len(project):].lstrip("/") if (project and path.startswith(project)) else path
base = os.path.basename(path)

# Find this file's lines in the index. Format: 'path  Lstart-Lend  type ...'
# (tab- or space-delimited). Track the max end line for an exact rel match;
# fall back to basename if the project prefix didn't line up.
RANGE_RE = re.compile(r"L?(\d+)\s*-\s*L?(\d+)")
max_end_exact = 0
max_end_base = 0
sec_exact = []   # (start, end, type, symbol) for this file — shown in the deny message
sec_base = []
try:
    with open(index, encoding="utf-8", errors="replace") as f:
        for line in f:
            parts = line.split("\t") if "\t" in line else line.split()
            if len(parts) < 2:
                continue
            p = parts[0]
            # The index may store absolute OR project-relative paths.
            if p != rel and p != path and os.path.basename(p) != base:
                continue
            m = RANGE_RE.search(parts[1]) or RANGE_RE.search(line)
            if not m:
                continue
            start, end = int(m.group(1)), int(m.group(2))
            typ = parts[2].strip() if len(parts) > 2 else ""
            sym = parts[3].strip() if len(parts) > 3 else ""
            if p == rel or p == path:
                max_end_exact = max(max_end_exact, end)
                if typ != "full":
                    sec_exact.append((start, end, typ, sym))
            if os.path.basename(p) == base:
                max_end_base = max(max_end_base, end)
                if typ != "full":
                    sec_base.append((start, end, typ, sym))
except OSError:
    sys.exit(0)

lines = max_end_exact or max_end_base
if lines < THRESHOLD:
    # No index entry (or a small one) doesn't mean the file is small — it may
    # just never have been indexed (wrong dir, unindexed extension, a huge
    # vendored/generated file skipped for cost reasons). Fall back to an
    # actual line count so those don't slip through as "small enough".
    if lines > 0:
        sys.exit(0)  # indexed AND genuinely small — allow
    try:
        with open(path, "rb") as f:
            actual = sum(1 for _ in f)
    except OSError:
        sys.exit(0)  # can't stat it -> allow rather than false-block
    if actual < THRESHOLD:
        sys.exit(0)
    lines = actual

# Identical-retry approval memory (the write-guard/bash-guard contract):
# the FIRST whole-read of this file is denied with the section map below;
# re-issuing the IDENTICAL Read passes. A denied read we cannot remember
# would deny forever, so persistence failure allows.
sid = str(data.get("session_id") or "global")
key = hashlib.sha1(("read|" + sid + "|" + path).encode("utf-8", "replace")).hexdigest()
state_path = os.path.join(project, ".claude-ide", ".read-guard-state.json")
if not os.path.isdir(project):
    state_path = os.path.join(tempfile.gettempdir(), "claude-ide-read-guard-state.json")
state = {}
try:
    with open(state_path, encoding="utf-8") as f:
        state = json.load(f) or {}
    if not isinstance(state, dict):
        state = {}
except Exception:
    state = {}
now = time.time()
state = {k: t for k, t in state.items()
         if isinstance(t, (int, float)) and now - t < APPROVAL_TTL}
if key in state:
    state.pop(key, None)  # consume the approval
    try:
        with open(state_path, "w", encoding="utf-8") as f:
            json.dump(state, f)
    except Exception:
        pass
    sys.exit(0)  # identical retry -> allowed
state[key] = now
if len(state) > STATE_MAX:
    for k in sorted(state, key=state.get)[: len(state) - STATE_MAX]:
        state.pop(k, None)
try:
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    with open(state_path, "w", encoding="utf-8") as f:
        json.dump(state, f)
except Exception:
    sys.exit(0)  # cannot remember the strike -> allow

# Include the file's actual section map so the denial IS the answer: the
# model can pick a symbol/span directly instead of a second lookup step.
secs = sec_exact or sec_base
secs.sort(key=lambda t: t[0])
sec_block = ""
if secs:
    shown = secs[:14]
    listing = "\n".join(
        f"  L{a}-L{b}  {t or '?'}  {s or '?'}" for a, b, t, s in shown)
    more = len(secs) - len(shown)
    tail = f"\n  ...and {more} more: grep '{base}' .claude-ide/repo-index.txt" if more > 0 else ""
    sec_block = f"\nSection map of '{base}' (from the repo index):\n{listing}{tail}\n"

sys.stderr.write(
    f"BLOCKED by claude-ide harness: '{base}' is ~{lines} lines — too large to Read whole.\n"
    f"Use the structured tools instead of pulling the entire file into context:\n"
    f"  - list_symbols {{path: '{rel}'}} -> what this file exposes (cheap overview)\n"
    f"  - get_section {{path: '{rel}', symbol: '<name>'}} -> just that function/class body\n"
    f"  - find_definition {{symbol}} / find_references {{symbol}} -> jump to the exact site\n"
    f"  - or grep the section map: grep '{base}' .claude-ide/repo-index.txt\n"
    f"{sec_block}"
    f"\n"
    f"If you genuinely need a span of this file, re-Read with an explicit\n"
    f"offset/limit (e.g. offset=<Lstart> limit=<Lend-Lstart>) — that is allowed.\n"
    f"If the task truly needs the WHOLE file (full review/rewrite), re-issue the\n"
    f"IDENTICAL Read — it will pass (the acknowledgement is remembered for 24h).\n"
    f"To disable this hook: remove the PreToolUse/Read entry from\n"
    f".claude/settings.json (Project Settings -> Hooks editor in the IDE).\n"
)
sys.exit(2)
