#!/usr/bin/env python3
"""
HTML data-attr guard — auto-installed by Claude IDE.

PostToolUse hook on Write/Edit/MultiEdit. When Claude writes an HTML-
bearing file (.html .htm .vue .svelte .jsx .tsx .astro), this scans the
RESULTING file for opening tags that lack a data-* attribute. Reports
any misses as exit-2 feedback so Claude sees the violations on its next
turn and can fix them.

PostToolUse (not Pre): the file is already on disk, so the user keeps
the write. The model gets a structured nudge to add the missing
attributes in the next step, rather than the tool itself being blocked.

Skipped tag set is deliberately broad: structural elements (html/head/
body), void/metadata elements (br/hr/meta/link/...), and the entire SVG
inner tag family (path/circle/g/...) where requiring data-* per node
would be noise. Custom elements (<my-thing>) ARE checked.

To disable: remove the PostToolUse hook entry pointing at this script
in .claude/settings.json (or use the IDE's Hooks editor).
"""
import json, re, sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

inp = data.get("tool_input") or {}
path = inp.get("file_path") or inp.get("path") or ""
if not path:
    sys.exit(0)

# Only check files that contain HTML element syntax.
HTML_EXTS = (".html", ".htm", ".vue", ".svelte", ".jsx", ".tsx", ".astro")
if not path.lower().endswith(HTML_EXTS):
    sys.exit(0)

try:
    text = open(path, "r", encoding="utf-8", errors="ignore").read()
except Exception:
    sys.exit(0)

# Matches an opening tag (not </close>, not <!-- comment -->, not <?xml?>).
# Captures: 1 = tag name, 2 = the attribute span (may be empty).
TAG_RE = re.compile(r"<([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^>]*)?)>", re.MULTILINE)

SKIP_TAGS = {
    # Structural — one each, not data-targetable in any useful sense.
    "html", "head", "body",
    # Head metadata — not user-visible.
    "meta", "link", "title", "base",
    # Void / line-break / pure markup elements.
    "br", "hr", "wbr", "col", "source", "track", "area", "embed", "param",
    # Script-likes.
    "style", "script", "noscript", "template",
    # SVG inner tags — flagging every <path>/<circle>/<g> in an icon set
    # would be pure noise. The outer <svg> wrapper IS skipped too; users
    # who want to id an SVG should wrap it.
    "svg", "path", "circle", "rect", "ellipse", "line", "polyline", "polygon",
    "g", "defs", "use", "symbol", "filter", "mask", "pattern", "clippath",
    "linearGradient", "radialGradient", "stop", "tspan", "desc",
    "feGaussianBlur", "feColorMatrix", "feMerge", "feMergeNode", "feOffset",
    "feFlood", "feComposite", "feBlend", "feMorphology", "feTurbulence",
}

missing = []
for m in TAG_RE.finditer(text):
    tag = m.group(1).lower()
    if tag in SKIP_TAGS:
        continue
    attrs = m.group(2) or ""
    # Match data-foo or data-foo-bar inside the attrs span; lowercase
    # token boundary so foo-data-bar doesn't false-positive.
    if re.search(r"(?:^|\s)data-[a-zA-Z][\w-]*", attrs):
        continue
    line = text.count("\n", 0, m.start()) + 1
    missing.append((tag, line))

if not missing:
    sys.exit(0)

preview = missing[:10]
extra = len(missing) - len(preview)
listing = "\n".join(f"  {path}:{ln} <{t}>" for t, ln in preview)
suffix = f"\n  …and {extra} more" if extra > 0 else ""

sys.stderr.write(
    f"[claude-ide html-data-attr-guard] {len(missing)} HTML element(s) without a data-* attribute in {path}:\n"
    f"{listing}{suffix}\n"
    f"\n"
    f"Per CLAUDE.md: add a unique data-* attribute (e.g. data-component=\"name\", data-testid=\"x\")\n"
    f"to each HTML element you create or edit. This is auto-installed by Claude IDE.\n"
    f"Disable in Project Settings → Hooks editor if not wanted.\n"
)
sys.exit(2)
