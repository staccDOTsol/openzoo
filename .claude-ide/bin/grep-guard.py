#!/usr/bin/env python3
"""
Grep-guard PreToolUse hook — auto-installed by Claude IDE.

Blocks Grep tool calls whose pattern looks like a single source-code
symbol, with feedback telling Claude to use the claude-ide MCP server's
find_definition / find_references instead. Symbol lookups via raw grep
return dozens of false matches (same name in comments, docs,
similarly-named identifiers) that bloat context for zero useful signal.

Conservative — only blocks when ALL of:
  - pattern is a single identifier of length >= 4 (no spaces / regex)
  - search target is not a doc file (.md/.txt/.json/.yaml/.toml/lock)

False positives are way more annoying than missed nudges, so we err
toward letting Grep through. To disable entirely: remove this hook
from .claude/settings.json (or use the IDE's Hooks editor).
"""
import json, re, sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

tool_input = data.get("tool_input") or {}
pattern    = str(tool_input.get("pattern") or "")
path_filt  = str(tool_input.get("path")    or "")
glob_filt  = str(tool_input.get("glob")    or "")
type_filt  = str(tool_input.get("type")    or "")

SYMBOL_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{3,}$")
if not SYMBOL_RE.match(pattern):
    sys.exit(0)

DOC_RE = re.compile(r"\.(md|markdown|txt|rst|json|ya?ml|toml|lock|csv)\b", re.IGNORECASE)
if DOC_RE.search(path_filt) or DOC_RE.search(glob_filt):
    sys.exit(0)
if type_filt.lower() in {"md", "txt", "rst", "json", "yaml", "yml", "toml"}:
    sys.exit(0)

sys.stderr.write(
    f"BLOCKED by claude-ide harness: pattern '{pattern}' looks like a symbol name.\n"
    f"Structured lookups beat text grep for symbols (no comment/doc false matches):\n"
    f"  - find_definition {{symbol: '{pattern}'}} -> definition site(s) with lines\n"
    f"  - find_references {{symbol: '{pattern}'}} -> caller/usage sites\n"
    f"  - search_code {{query}} -> ranked matches if it's a concept, not an identifier\n"
    f"  - shell fallback: ./.claude-ide/bin/find-def or who-calls '{pattern}'\n"
    f"\n"
    f"If you really need a text search for '{pattern}' (e.g. in markdown docs),\n"
    f"pass an explicit glob/path/type that targets docs (e.g. glob='*.md') —\n"
    f"doc-targeted Grep is always allowed. (Shell grep is guarded too.)\n"
    f"\n"
    f"To disable this hook: remove the PreToolUse/Grep entry from\n"
    f".claude/settings.json (Project Settings -> Hooks editor in the IDE).\n"
)
sys.exit(2)
