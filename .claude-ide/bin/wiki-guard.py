#!/usr/bin/env python3
"""
Wiki-guard PostToolUse hook — auto-installed by Claude IDE.

Closes the "fixed but never cleaned" wiki loop. Wiki entries describe
landmines tied to code state; when an edit lands in a file the wiki talks
about, THIS moment — while the fix is still in the model's context — is
the only reliable chance to retire the entry. The hook feeds a short
checklist back (exit 2 stderr; PostToolUse runs after the write, so
nothing is blocked): re-check the referencing sections, update or
SUPERSEDE any the edit just invalidated, ignore if all still hold.

Noise budget (this must never become a nag):
  - fires at most ONCE per (session, file) — 24h state, like the other
    guards (.claude-ide/.wiki-guard-state.json)
  - only successful Write/Edit/MultiEdit on real project files
  - never for .claude/wiki.md itself (that edit IS the cleanup), nor
    .claude/ or .claude-ide/ internals, build dirs, or tmp paths
  - lists at most 5 referencing sections, headings only
  - fail-open: any internal error exits 0 silently

NOTE: embedded in a JS template literal (project-settings.js) — this file
must stay free of backslashes, backticks, and dollar-brace sequences.
"""
import hashlib, json, os, re, sys, time

NL = chr(10)
STATE_TTL = 24 * 3600
STATE_MAX = 400
MAX_LIST = 5

SKIP_SEGS = ("node_modules", ".git", "dist", "build", "out", "target",
             "__pycache__", ".next", ".cache", "vendor", "coverage",
             ".claude-ide", ".claude", "tmp")

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
resp = data.get("tool_response")
if isinstance(resp, dict) and (resp.get("error") or resp.get("success") is False):
    sys.exit(0)  # failed writes leave nothing to re-check

project = os.environ.get("CLAUDE_PROJECT_DIR") or str(data.get("cwd") or "")
if not project or not os.path.isdir(project):
    sys.exit(0)
project = os.path.realpath(project)
rp = os.path.realpath(path) if os.path.exists(path) else os.path.normpath(path)
if not rp.startswith(project + "/"):
    sys.exit(0)
rel = rp[len(project) + 1:]
segs = rel.split("/")
if any(s in SKIP_SEGS for s in segs):
    sys.exit(0)
tmpdir = os.environ.get("TMPDIR") or "/tmp"
if rp.startswith(("/tmp/", "/private/tmp/", "/var/folders/")) or rp.startswith(tmpdir):
    sys.exit(0)

wiki = os.path.join(project, ".claude", "wiki.md")
try:
    text = open(wiki, encoding="utf-8", errors="replace").read()
except OSError:
    sys.exit(0)

base = os.path.basename(rel)
if len(base) < 5 or "." not in base:
    sys.exit(0)  # too generic to reference-match reliably


def references(hay, needle):
    """needle appears in hay as a standalone filename token: preceding char
    is a path separator / whitespace / punctuation (not part of a longer
    name like prompt-welcome.js), and the following char is not a name
    char. Manual scan — no backslash regex in this file."""
    h = hay.lower()
    n = needle.lower()
    i = h.find(n)
    while i >= 0:
        prev = h[i - 1] if i > 0 else " "
        nxt = h[i + len(n)] if i + len(n) < len(h) else " "
        prev_ok = not (prev.isalnum() or prev in "_-.")
        nxt_ok = not (nxt.isalnum() or nxt in "_-")
        if prev_ok and nxt_ok:
            return True
        i = h.find(n, i + 1)
    return False


sections = []  # (line, heading)
head, body_lines, start = None, [], 0
for ln, line in enumerate(text.splitlines(), 1):
    if re.match("^#{2,3} ", line):
        if head is not None:
            sections.append((start, head, NL.join(body_lines)))
        head, body_lines, start = line.lstrip("#").strip(), [], ln
    elif head is not None:
        body_lines.append(line)
if head is not None:
    sections.append((start, head, NL.join(body_lines)))

hits = []
for start, heading, body in sections:
    if "SUPERSEDED" in body[:300]:
        continue
    if references(heading, base) or references(body, base):
        hits.append((start, heading))
if not hits:
    sys.exit(0)

# Once per (session, file): approval-memory style state, 24h TTL.
sid = str(data.get("session_id") or "global")
key = hashlib.sha1(("wg|" + sid + "|" + rel).encode("utf-8", "replace")).hexdigest()
state_path = os.path.join(project, ".claude-ide", ".wiki-guard-state.json")
state = {}
try:
    state = json.load(open(state_path, encoding="utf-8")) or {}
    if not isinstance(state, dict):
        state = {}
except Exception:
    state = {}
now = time.time()
state = {k: t for k, t in state.items()
         if isinstance(t, (int, float)) and now - t < STATE_TTL}
if key in state:
    sys.exit(0)  # already nudged for this file this session
state[key] = now
if len(state) > STATE_MAX:
    for k in sorted(state, key=state.get)[: len(state) - STATE_MAX]:
        state.pop(k, None)
try:
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    json.dump(state, open(state_path, "w", encoding="utf-8"))
except Exception:
    sys.exit(0)  # cannot remember -> stay silent rather than nag every edit

shown = hits[:MAX_LIST]
listing = NL.join("  [wiki.md L" + str(l) + "] " + h for l, h in shown)
more = len(hits) - len(shown)
tail = NL + "  ...and " + str(more) + " more (grep '" + base + "' .claude/wiki.md)" if more > 0 else ""
sys.stderr.write(
    "[claude-ide wiki-guard] Post-edit wiki check for " + rel
    + " (checklist, NOT an error — the edit succeeded):" + NL
    + listing + tail + NL
    + "These durable wiki entries reference the file you just changed. If your edit" + NL
    + "FIXED, removed, or reworked what any of them describe, update .claude/wiki.md" + NL
    + "now — rewrite the entry, or mark its first body line 'SUPERSEDED — see" + NL
    + "<newer heading>' so recall stops injecting a stale landmine. If they all" + NL
    + "still hold, no wiki action is needed — just continue your task." + NL
    + "(Fires once per file per session. Disable: remove the wiki-guard PostToolUse" + NL
    + "entry in .claude/settings.json.)" + NL
)
sys.exit(2)
