#!/usr/bin/env python3
"""
Syntax-guard PostToolUse hook — auto-installed by Claude IDE.

After Claude writes a .js/.mjs/.cjs/.json/.py file, parse it; on failure
exit 2 so the error lands in front of the model NOW. With the IDE's
hot-reload, a syntax error otherwise surfaces as a silently broken running
app (or a failed build minutes later), and the user pays the debugging.

JS strategy: node --check on the real path first (respects the nearest
package.json "type"), then temp copies checked as ESM (.mjs) and as CJS
(.cjs). Only if EVERY mode fails is it reported — a file valid in any JS
mode is never flagged, which kills ESM-vs-CJS false positives. .jsx/.ts/
.tsx are skipped entirely (node cannot parse them).

JSON: strict json.load, but JSONC-by-convention files (tsconfig*/
jsconfig*, anything in .vscode/, devcontainer.json) are skipped.
Python: compile() in-process.
CSS/SCSS: structural check only (comment/string-aware curly-brace
balance + unterminated block comment) — not a grammar. Catches the
"one missing brace silently kills every rule below it" hot-reload trap
with zero false positives on valid files.

Fail-open: node missing, file > 2MB, unreadable, subprocess timeout ->
exit 0. This hook never blocks the write (PostToolUse: the file is already
on disk); it only feeds the parse error back so the very next action is
the fix. To disable: remove the PostToolUse entry pointing at
syntax-guard.py in .claude/settings.json (Project Settings -> Hooks
editor in the IDE).
"""
import json, os, shutil, subprocess, sys, tempfile

NL = chr(10)

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not isinstance(data, dict):
    sys.exit(0)

ti = data.get("tool_input") or {}
path = str(ti.get("file_path") or "")
if not path or not os.path.isfile(path):
    sys.exit(0)

SKIP_SEGS = {"node_modules", ".git", "dist", "build", "target", ".claude-ide",
             "__pycache__", ".next", ".cache", "vendor", "coverage"}
if any(seg in SKIP_SEGS for seg in path.split("/")):
    sys.exit(0)
try:
    if os.path.getsize(path) > 2000000:
        sys.exit(0)
except OSError:
    sys.exit(0)

base = os.path.basename(path)
low = base.lower()
ext = os.path.splitext(low)[1]


def report(kind, detail):
    detail = (detail or "").strip()
    if len(detail) > 1600:
        detail = detail[:1600] + " ..."
    sys.stderr.write(
        "[claude-ide syntax-guard] " + base + " does not parse (" + kind + ") after your edit:" + NL
        + detail + NL
        + "The broken file IS saved on disk — hot reload / the next build will fail. Fix it now." + NL
        + "If this file intentionally uses non-standard syntax (e.g. JSX inside a .js file)," + NL
        + "disable this check: remove the syntax-guard PostToolUse entry in .claude/settings.json" + NL
        + "(Project Settings -> Hooks editor in the IDE)." + NL
    )
    sys.exit(2)


if ext == ".json":
    parent = os.path.basename(os.path.dirname(path))
    # JSONC-by-convention files legally carry comments/trailing commas.
    if parent == ".vscode" or low.startswith(("tsconfig", "jsconfig")) or low == "devcontainer.json":
        sys.exit(0)
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            json.load(f)
    except Exception as e:
        report("JSON", str(e))
    sys.exit(0)

if ext == ".py":
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            src = f.read()
        compile(src, path, "exec")
    except SyntaxError as e:
        report("Python", "line " + str(e.lineno) + ": " + str(e.msg))
    except Exception:
        pass
    sys.exit(0)

if ext in (".js", ".mjs", ".cjs"):
    node = shutil.which("node")
    if not node:
        sys.exit(0)

    def check(target):
        try:
            r = subprocess.run([node, "--check", target], capture_output=True, text=True, timeout=10)
            return r.returncode == 0, (r.stderr or r.stdout or "")
        except Exception:
            return True, ""  # infra failure -> treat as pass (fail open)

    ok, err = check(path)
    if ok:
        sys.exit(0)
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            src = f.read()
    except OSError:
        sys.exit(0)
    # Re-check as ESM and as CJS via temp copies; valid-in-any-mode passes.
    for suffix in (".mjs", ".cjs"):
        tf = tempfile.NamedTemporaryFile("w", suffix=suffix, delete=False, encoding="utf-8")
        try:
            tf.write(src)
            tf.close()
            ok2, _ = check(tf.name)
        finally:
            try:
                os.unlink(tf.name)
            except OSError:
                pass
        if ok2:
            sys.exit(0)
    report("JavaScript", err)

if ext in (".css", ".scss"):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            src = f.read()
    except OSError:
        sys.exit(0)
    BS = chr(92)
    DQ = chr(34)
    line = 1
    mode = ""           # "" | "comment" | "line" | "'" | '"'
    open_lines = []     # line numbers of currently-unmatched '{'
    bad = None          # (line, message) — first structural error found
    i, n = 0, len(src)
    while i < n and not bad:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        if c == NL:
            line += 1
            if mode == "line":
                mode = ""
            elif mode in ("'", DQ):
                mode = ""  # raw newline in a string: browsers recover — skip
            i += 1
            continue
        if mode == "comment":
            if c == "*" and nxt == "/":
                mode = ""
                i += 1
            i += 1
            continue
        if mode == "line":
            i += 1
            continue
        if mode in ("'", DQ):
            if c == BS:
                i += 2  # escaped char (incl. escaped quote/newline)
                continue
            if c == mode:
                mode = ""
            i += 1
            continue
        if c == "/" and nxt == "*":
            mode = "comment"
            i += 2
            continue
        # SCSS line comments only — plain CSS has none, and "//" appears
        # inside unquoted url(https://...) values; the ":" guard keeps
        # protocol slashes out of comment mode there too.
        if ext == ".scss" and c == "/" and nxt == "/" and (i == 0 or src[i - 1] != ":"):
            mode = "line"
            i += 2
            continue
        if c in ("'", DQ):
            mode = c
            i += 1
            continue
        if c == "{":
            open_lines.append(line)
            i += 1
            continue
        if c == "}":
            if not open_lines:
                bad = (line, "'}' with no matching '{'")
            else:
                open_lines.pop()
            i += 1
            continue
        i += 1
    if bad:
        report("CSS", "line " + str(bad[0]) + ": " + bad[1])
    if mode == "comment":
        report("CSS", "unterminated block comment (/* without */)")
    if open_lines:
        report("CSS", "unclosed '{' opened on line " + str(open_lines[-1])
               + (" (+" + str(len(open_lines) - 1) + " more)" if len(open_lines) > 1 else ""))
    sys.exit(0)

sys.exit(0)
