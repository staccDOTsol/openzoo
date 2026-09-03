## Project Wiki

Before starting any task, read `.claude/wiki.md` (if it exists) for project-specific decisions, constraints, and context that must not be violated. Update it when you learn new non-obvious facts.

---

# CLAUDE.md

<!-- IDE-SAFETY-START — managed by Claude IDE, do not edit this line -->

## Editing safety rules

**Never mass-delete code.** When modifying an existing file:

- Default to the `Edit` tool (or `MultiEdit`) for surgical, line-targeted changes. `Write` overwrites the entire file — only use it for files you are creating from scratch.
- If you believe code should be removed, **first explain WHAT will be removed and WHY** in your response, then propose the smallest possible deletion. Wait for the user to confirm before removing >30 lines in a single edit.
- A "simplification" or "cleanup" pass is not a license to drop functionality. If the file currently exports/uses a function, helper, or branch, that behavior must remain unless the user has explicitly asked you to remove it.
- Do not rewrite a file "from scratch" to make it shorter. Refactoring within the existing structure is almost always safer.
- If a file fails to compile or a test breaks after your edit, fix the edit — don't delete the failing code.

**Why this matters:** the user has lost work twice from large `Write` operations that stripped out functioning code while pursuing a smaller-feeling refactor. The cost of being conservative on deletion is one extra round-trip; the cost of being wrong is hours of redo work.

<!-- IDE-SAFETY-END -->

<!-- REPO-INDEX-START — managed by Claude IDE, do not edit this line -->

## IDE harness — navigation tools

This project runs in Claude IDE: a live repo index + the `claude-ide` MCP server are wired automatically.

**Orientation:** call `project_overview` first in a fresh session (codebase map + index stats + tool list). The map also lives at `.claude/MAP.md`.

**Navigation — prefer these over Grep/Glob for code structure:**
- `find_file({query})` — resolve a partial filename to real paths; use before Read/Edit on a file you haven't seen this session
- `search_code({query, path?})` — ranked "where is X handled?" across symbols/paths/summaries, returns line ranges
- `find_definition({symbol})` / `find_references({symbol})` — exact definition & caller sites (comment/string-stripped index, not text grep)
- `get_section({path, symbol})` — read ONE function/class body instead of the whole file; self-heals if the file changed
- `list_symbols({path?})` — what a file/dir exposes, without reading it
- `read_exact({path, anchor? | start_line/end_line?})` — a span as verbatim bytes (no line-number prefixes) for building Edit `old_string`; after a "String to replace not found" failure, pass the failed old_string as `anchor` to get the real bytes back

**Files >500 lines:** never Read them whole. Use `get_section`, or `grep '<filename>' .claude-ide/repo-index.txt` to see the section map (`path Lstart-Lend type symbol summary`), then Read with offset/limit.

Shell fallbacks (if MCP is unavailable): `./.claude-ide/bin/find-def <sym>` · `./.claude-ide/bin/who-calls <sym>` · `./.claude-ide/bin/resolve-path <partial>`.
Use Grep for free text (strings, comments, docs, CSS selectors) — for identifiers it returns mostly noise.

<!-- REPO-INDEX-END -->
<!-- AUTHORING-RULES-START — managed by Claude IDE, do not edit this line -->

## Authoring rules

**Add a unique `data-*` attribute to your HTML elements.** Every element you create or edit in `.html` / `.jsx` / `.tsx` / `.vue` / `.svelte` / `.astro` files should carry one — for example `data-component="header"`, `data-testid="submit-button"`, or `data-feature="nav-link"`. This is enforced by a `PostToolUse` hook (`.claude-ide/bin/html-data-attr-guard.py`); writes that violate the rule are flagged on the next turn so you can fix them.

Exceptions: structural shell tags (`<html>` / `<head>` / `<body>`), head metadata (`<meta>` / `<link>` / `<title>`), void elements (`<br>` / `<hr>` / `<wbr>` / `<source>` / `<track>`), and SVG inner tags (`<path>` / `<circle>` / `<g>` etc.) — the guard skips them.

<!-- AUTHORING-RULES-END -->