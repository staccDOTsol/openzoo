#!/usr/bin/env python3
"""
Bash-guard PreToolUse hook — auto-installed by Claude IDE.

The dedicated file tools are guarded (write-guard mass-delete protection +
Edit pre-flight, syntax-guard parse checks, html-data-attr rule, read-guard
section discipline) — but the SAME operations issued through Bash were not,
and the embedded Claude runs with --dangerously-skip-permissions, so there
is no permission-prompt backstop either. This hook closes the bypass:

1. Write bypass (all models). sed -i / perl -i / tee / '>' truncating
   redirection into a project source file is denied with "use Write/Edit
   instead" — those routes re-enter the guards. '>>' and tee -a appends
   are allowed (they cannot destroy existing content).
2. Recursive delete speed bump (all models). rm -r (and find -delete) on
   project paths that are not disposable build dirs is denied ONCE; the
   identical retry passes (approval memory, 24h TTL — the write-guard
   contract).
3. Whole-file cat of a big file (all models). read-guard blocks Read on
   big indexed files; without this rule "cat file.js" was the obvious
   escape hatch. Unpiped, unredirected cat of a >500-line project file is
   denied with the bounded alternatives.
4. Search discipline. Lite tiers: grep -r / rg over the tree and
   find -name are denied once, pointing at the Grep/Glob tools. ALL
   tiers: a wide shell grep whose pattern is a bare identifier (>=4
   chars) is denied once pointing at find_definition/find_references —
   observed live as the standard capable-model bypass around the
   Grep-tool symbol guard. Free-text greps stay open for capable tiers.

Tier comes from CLAUDE_IDE_MODEL_TIER (stamped per provider by the IDE);
fallback: ANTHROPIC_MODEL matching a known lite-model family.

Quote-, heredoc- and pipe-aware: heredoc bodies and quoted strings are
never scanned as commands, "cat x | head" is a bounded read (allowed),
"sh -c '...'" is scanned recursively, "$(...)" contents are scanned as
their own commands.

Fail-open by design: any internal error exits 0 and the command runs.
To disable: remove the PreToolUse Bash entry from .claude/settings.json
(Project Settings -> Hooks editor in the IDE).
"""
import hashlib, json, os, sys, tempfile, time

NL = chr(10)
TAB = chr(9)
BS = chr(92)
SQ = chr(39)
DQ = chr(34)
BT = chr(96)
APPROVAL_TTL = 24 * 3600
STATE_MAX = 300
CAT_LINE_LIMIT = 500
MAX_STAT_BYTES = 8000000

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not isinstance(data, dict):
    sys.exit(0)
if str(data.get("tool_name") or "") != "Bash":
    sys.exit(0)
ti = data.get("tool_input") or {}
cmd_str = str(ti.get("command") or "")
if not cmd_str.strip():
    sys.exit(0)

project = os.environ.get("CLAUDE_PROJECT_DIR") or str(data.get("cwd") or "")
if not project:
    sys.exit(0)
project = os.path.realpath(project)
cwd = str(data.get("cwd") or "") or project

tier = (os.environ.get("CLAUDE_IDE_MODEL_TIER") or "").strip().lower()
model = (os.environ.get("ANTHROPIC_MODEL") or "").lower()
LITE_FAMILIES = ("deepseek", "qwen", "glm", "kimi", "llama", "mistral", "minimax")
if tier in ("lite", "full"):
    IS_LITE = tier == "lite"
else:
    IS_LITE = any(f in model for f in LITE_FAMILIES)
EMBEDDED = os.environ.get("CLAUDE_IDE_EMBEDDED") == "1"

# Pipe-exit-code advisory (Harness v7): build/test commands whose failure
# must not be masked by a downstream filter. A pipe like 'cargo check | tail'
# reports the FILTER's exit code — a failed build can look green (observed
# live).
LIKELY_FAIL = ("cargo", "npm", "npx", "yarn", "pnpm", "make", "tsc",
               "eslint", "pytest", "node", "python3", "python", "rustc",
               "go", "dotnet", "meson", "ninja")
PIPE_FILTERS = ("tail", "head", "grep", "egrep", "fgrep", "rg", "sed", "awk")

SRC_EXTS = {
    "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "py", "rs", "go", "rb",
    "php", "java", "kt", "c", "h", "cpp", "hpp", "cc", "hh", "cs", "css",
    "scss", "sass", "less", "html", "htm", "vue", "svelte", "astro", "md",
    "toml", "yml", "yaml", "sql", "sh", "zsh", "bash", "swift", "m", "mm",
    "lua", "dm", "dmm",
}
SKIP_SEGS = {"node_modules", ".git", "dist", "build", "out", "target",
             ".claude-ide", "__pycache__", ".next", ".nuxt", ".cache",
             "vendor", "coverage", "tmp"}
DISPOSABLE_SEGS = {"node_modules", "dist", "build", "out", "target", ".cache",
                   "coverage", "__pycache__", ".next", ".nuxt", "vendor",
                   "tmp", ".tmp", ".claude-ide", ".parcel-cache", ".turbo",
                   ".venv", "venv", ".pytest_cache", "DerivedData", ".gradle"}
WRAPPERS = {"sudo", "command", "nohup", "time", "nice", "env", "stdbuf",
            "caffeinate"}
SHELLS = {"sh", "bash", "zsh", "dash"}


def is_tmpish(p):
    tmpdir = os.environ.get("TMPDIR") or "/tmp"
    if p.startswith(("/tmp/", "/private/tmp/", "/var/folders/", "/dev/")):
        return True
    return bool(tmpdir) and p.startswith(tmpdir)


def resolve(word):
    """Word -> absolute normalized path, or None when it cannot be a static
    path (flag, empty, contains an unexpandable $VAR). Glob words resolve to
    the deepest literal directory prefix ('src/*' -> src, '*' -> cwd)."""
    w = word.strip()
    if not w or w.startswith("-") or "$" in w:
        return None
    gi = -1
    for g in ("*", "?", "["):
        k = w.find(g)
        if k >= 0 and (gi < 0 or k < gi):
            gi = k
    if gi >= 0:
        head = w[:gi]
        w = head[: head.rfind("/") + 1] if "/" in head else "."
    w = os.path.expanduser(w)
    if not w.startswith("/"):
        w = os.path.join(cwd, w)
    return os.path.normpath(w)


def realish(p):
    return os.path.realpath(p) if os.path.exists(p) else os.path.normpath(p)


def inside_project(p):
    if not p:
        return False
    rp = realish(p)
    return rp == project or rp.startswith(project + "/")


def rel_segs(p):
    rp = realish(p)
    if not rp.startswith(project):
        return []
    return [s for s in rp[len(project):].split("/") if s]


def ext_of(p):
    b = os.path.basename(p)
    i = b.rfind(".")
    return b[i + 1:].lower() if i > 0 else ""


def protected_target(p):
    """A path whose CONTENT the other guards care about: inside the project,
    not in a build/vendored dir, not tmp, with a source-like extension."""
    if not p or not inside_project(p) or is_tmpish(p):
        return False
    if any(s in SKIP_SEGS for s in rel_segs(p)):
        return False
    return ext_of(p) in SRC_EXTS


def scan(cmd):
    """Split a shell string into simple commands, quote/heredoc-aware.
    Returns dicts: {words, redirs: [(mode, target)], piped_in, piped_out}.
    Heredoc bodies are skipped; (), $( ), backticks are command boundaries."""
    cmds = []
    words = []
    redirs = []
    cur = []
    have_chars = False
    in_s = False
    in_d = False
    piped_in = False
    pending_redir = None  # "trunc" | "append" | "in" when next word is a target

    def flush_word():
        nonlocal have_chars, pending_redir
        if cur or have_chars:
            w = "".join(cur)
            del cur[:]
            have_chars = False
            if pending_redir is not None:
                if pending_redir in ("trunc", "append"):
                    redirs.append((pending_redir, w))
                pending_redir = None
            else:
                words.append(w)

    def flush_cmd(pout):
        nonlocal piped_in, pending_redir
        flush_word()
        pending_redir = None
        if words or redirs:
            cmds.append({"words": list(words), "redirs": list(redirs),
                         "piped_in": piped_in, "piped_out": pout})
            del words[:]
            del redirs[:]
        piped_in = False

    i, n = 0, len(cmd)
    while i < n:
        ch = cmd[i]
        if in_s:
            if ch == SQ:
                in_s = False
            else:
                cur.append(ch)
            i += 1
            continue
        if in_d:
            if ch == BS and i + 1 < n:
                cur.append(cmd[i + 1])
                i += 2
                continue
            if ch == DQ:
                in_d = False
            else:
                cur.append(ch)
            i += 1
            continue
        if ch == BS and i + 1 < n:
            if cmd[i + 1] != NL:  # escaped newline = line continuation
                cur.append(cmd[i + 1])
                have_chars = True
            i += 2
            continue
        if ch == SQ:
            in_s = True
            have_chars = True
            i += 1
            continue
        if ch == DQ:
            in_d = True
            have_chars = True
            i += 1
            continue
        if ch == "<":
            if cmd[i:i + 3] == "<<<":
                i += 3
                continue  # herestring: following word is data for stdin
            if cmd[i:i + 2] == "<<":
                # Heredoc. Parse the delimiter, then skip the body wholesale —
                # its lines are CONTENT, not commands, and must never trip a
                # rule ("cat > x <<EOF" bodies routinely contain 'rm -rf' as
                # text). The '>' redirect before it is still caught normally.
                i += 2
                if i < n and cmd[i] == "-":
                    i += 1
                while i < n and cmd[i] in (" ", TAB):
                    i += 1
                dl = []
                while i < n and cmd[i] not in (" ", TAB, NL, ";", "|", "&",
                                               "<", ">", "(", ")"):
                    c2 = cmd[i]
                    if c2 in (SQ, DQ):
                        i += 1
                        continue
                    if c2 == BS and i + 1 < n:
                        dl.append(cmd[i + 1])
                        i += 2
                        continue
                    dl.append(c2)
                    i += 1
                delim = "".join(dl)
                j = cmd.find(NL, i)
                if j < 0:
                    i = n
                    continue
                j += 1
                while j < n:
                    k = cmd.find(NL, j)
                    line = cmd[j:k] if k >= 0 else cmd[j:]
                    if line.strip(" " + TAB) == delim:
                        j = k + 1 if k >= 0 else n
                        break
                    if k < 0:
                        j = n
                        break
                    j = k + 1
                i = j
                continue
            flush_word()
            pending_redir = "in"  # consume the input-redirect target
            i += 1
            continue
        if ch == ">":
            no_gap = i > 0 and cmd[i - 1] not in (" ", TAB)
            flush_word()
            # "2>" fd spec: the digit was glued to '>' and is not an argument
            if no_gap and words and words[-1].isdigit():
                words.pop()
            mode = "trunc"
            i += 1
            if i < n and cmd[i] == ">":
                mode = "append"
                i += 1
            if i < n and cmd[i] == "|":  # >| clobber form
                i += 1
            if i < n and cmd[i] == "&":
                i += 1  # fd dup (>&2): no path target
                while i < n and cmd[i].isdigit():
                    i += 1
                continue
            pending_redir = mode
            continue
        if ch == "&":
            if cmd[i:i + 2] == "&>":
                flush_word()
                i += 2
                mode = "trunc"
                if i < n and cmd[i] == ">":
                    mode = "append"
                    i += 1
                pending_redir = mode
                continue
            flush_cmd(False)
            i += 1
            if i < n and cmd[i] == "&":
                i += 1
            continue
        if ch == "|":
            if cmd[i:i + 2] == "||":
                flush_cmd(False)
                i += 2
                continue
            flush_cmd(True)
            piped_in = True
            i += 1
            continue
        if ch in (";", NL):
            flush_cmd(False)
            i += 1
            continue
        if ch == "$" and cmd[i:i + 2] == "$(":
            flush_cmd(False)  # substitution contents scan as their own commands
            i += 2
            continue
        if ch in ("(", ")") or ch == BT:
            flush_cmd(False)
            i += 1
            continue
        if ch in (" ", TAB):
            flush_word()
            i += 1
            continue
        cur.append(ch)
        have_chars = True
        i += 1
    flush_cmd(False)
    return cmds


def is_assignment(w):
    if "=" not in w or w.startswith("-"):
        return False
    name = w.split("=", 1)[0]
    return bool(name) and name.replace("_", "a").isalnum()


def strip_wrappers(words):
    w = list(words)
    while w and is_assignment(w[0]):
        w.pop(0)
    guard = 0
    while w and guard < 6:
        guard += 1
        prog = os.path.basename(w[0])
        if prog not in WRAPPERS:
            break
        w.pop(0)
        while w and (w[0].startswith("-") or is_assignment(w[0])):
            w.pop(0)
    return w


def eval_simple(c, out, depth=0):
    if depth > 4:
        return
    # Truncating redirects apply to ANY program — this is the write bypass.
    for mode, t in c["redirs"]:
        if mode != "trunc":
            continue  # append cannot destroy existing content
        p = resolve(t)
        if p and protected_target(p):
            out.append(("redir", p, ""))

    words = strip_wrappers(c["words"])
    if not words:
        return
    prog = os.path.basename(words[0])
    args = words[1:]

    if prog in SHELLS:
        # sh -c / zsh -lc '<payload>': the payload is a command string of its
        # own — scan it recursively so the quoting is not a bypass.
        seen_c = False
        for a in args:
            if a.startswith("-"):
                if "c" in a[1:]:
                    seen_c = True
                continue
            if seen_c:
                for sub in scan(a):
                    eval_simple(sub, out, depth + 1)
            break
        return

    if prog == "xargs":
        rest = [a for a in args if not a.startswith("-")]
        if rest:
            eval_simple({"words": rest, "redirs": [], "piped_in": True,
                         "piped_out": c["piped_out"]}, out, depth + 1)
        return

    if prog in ("sed", "perl"):
        if prog == "sed":
            inplace = any(a == "--in-place" or a.startswith("--in-place=") or
                          (a.startswith("-i") and not a.startswith("--"))
                          for a in args)
        else:
            # perl: -i only counts as the leading bundle letter (-i, -i.bak)
            # or right after p/n (-pi, -ni). Scanning the whole cluster would
            # false-positive on option ARGUMENTS like -Ilib ("l i b").
            inplace = any(a.startswith("-") and not a.startswith("--") and
                          (a[1:2] == "i" or a[1:3] in ("pi", "ni"))
                          for a in args)
        if inplace:
            for a in args:
                if a.startswith("-"):
                    continue
                p = resolve(a)
                if p and os.path.isfile(p) and protected_target(p):
                    out.append(("inplace", p, prog + " -i"))
        return

    if prog == "tee":
        if any(a in ("-a", "--append") for a in args):
            return  # append form: same contract as '>>'
        for a in args:
            if a.startswith("-"):
                continue
            p = resolve(a)
            if p and protected_target(p):
                out.append(("redir", p, "tee"))
        return

    if prog == "rm":
        recursive = any(a.startswith("-") and not a.startswith("--") and
                        ("r" in a[1:] or "R" in a[1:]) for a in args)
        recursive = recursive or "--recursive" in args
        if not recursive:
            return
        for a in args:
            if a.startswith("-"):
                continue
            p = resolve(a)
            if not p or not inside_project(p) or is_tmpish(p):
                continue
            if not os.path.exists(p):
                continue
            segs = rel_segs(p)
            if segs and any(s in DISPOSABLE_SEGS for s in segs):
                continue
            out.append(("rm", p, ""))
        return

    if prog == "cat":
        if c["piped_out"] or c["redirs"]:
            return  # bounded by a downstream filter, or the redirect rule owns it
        files = [a for a in args if not a.startswith("-")]
        if len(files) != 1:
            return
        p = resolve(files[0])
        if not p or not os.path.isfile(p) or not inside_project(p) or is_tmpish(p):
            return
        if any(s in SKIP_SEGS for s in rel_segs(p)):
            return
        try:
            if os.path.getsize(p) > MAX_STAT_BYTES:
                out.append(("cat", p, "very large"))
                return
            with open(p, encoding="utf-8", errors="replace") as f:
                n_lines = sum(1 for _ in f)
        except OSError:
            return
        if n_lines > CAT_LINE_LIMIT:
            out.append(("cat", p, str(n_lines) + " lines"))
        return

    if prog in ("grep", "egrep", "fgrep", "rg"):
        rec = any((a.startswith("-") and not a.startswith("--") and
                   ("r" in a[1:] or "R" in a[1:])) or a == "--recursive"
                  for a in args)
        pos = [a for a in args if not a.startswith("-")]
        pattern = ""
        if "-e" in args and args.index("-e") + 1 < len(args):
            pattern = args[args.index("-e") + 1]
        elif pos:
            pattern = pos[0]
        if pos and not any(a in ("-e", "--regexp", "-f") for a in args):
            pos = pos[1:]  # first positional is the pattern, not a path
        dirs = []
        onefile = False
        for a in pos:
            p = resolve(a)
            if p and os.path.isdir(p):
                dirs.append(a)
            elif p and os.path.isfile(p):
                onefile = True
        if prog == "rg":
            wide = bool(dirs) or (not onefile and not c["piped_in"])
        else:
            wide = rec or bool(dirs)
        if not wide:
            return
        if IS_LITE:
            out.append(("search", prog, ""))
        elif pattern.isidentifier() and len(pattern) >= 4:
            # Capable tiers get SYMBOL discipline only: a wide shell grep
            # for a bare identifier is the classic bypass around the
            # Grep-tool guard (whose old message even suggested it), and
            # the repo index answers identifier questions precisely.
            # Free-text greps (strings, selectors, multi-word) stay open.
            out.append(("symsearch", prog, pattern))
        return

    if prog == "find":
        if "-delete" in args:
            root = next((a for a in args if not a.startswith("-")), None)
            p = resolve(root) if root else None
            if p and inside_project(p) and os.path.exists(p):
                segs = rel_segs(p)
                if not (segs and any(s in DISPOSABLE_SEGS for s in segs)):
                    out.append(("rm", p, "find -delete"))
        if IS_LITE and any(a in ("-name", "-iname", "-path", "-ipath",
                                 "-regex") for a in args):
            out.append(("find", "", ""))
        for exe in ("-exec", "-execdir", "-ok"):
            if exe in args:
                k = args.index(exe)
                sub = [a for a in args[k + 1:] if a not in (";", "+", "{}")]
                if sub:
                    eval_simple({"words": sub, "redirs": [], "piped_in": False,
                                 "piped_out": False}, out, depth + 1)
                break
        return


def advise(note):
    """Non-blocking guidance. PreToolUse 'allow' + additionalContext puts the
    note in the MODEL's context and lets the command run — no wasted turn, and
    no deny-once approval slot to be consumed by an identical retry.

    Verified live (2026-08-27) against Claude Code 2.1.238: additionalContext
    reaches the model (it quoted the note back), while systemMessage does NOT
    — that field is user-facing terminal text only. Do not swap them."""
    out = {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "allow",
        "additionalContext": "[claude-ide bash-guard] " + note,
    }}
    sys.stdout.write(json.dumps(out))
    sys.exit(0)


def strike(op, payload, reason, guidance):
    """Write-guard contract: first identical attempt is denied with guidance;
    the IDENTICAL retry passes (sha1 approval memory, 24h TTL). If the strike
    cannot be persisted, allow — a deny we cannot remember denies forever."""
    sid = str(data.get("session_id") or "global")
    digest = hashlib.sha1(payload.encode("utf-8", "replace")).hexdigest()
    key = hashlib.sha1("|".join([sid, op, digest]).encode("utf-8", "replace")).hexdigest()
    state_path = os.path.join(project, ".claude-ide", ".bash-guard-state.json")
    if not os.path.isdir(project):
        state_path = os.path.join(tempfile.gettempdir(), "claude-ide-bash-guard-state.json")
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
        return  # identical retry -> allowed
    state[key] = now
    if len(state) > STATE_MAX:
        for k in sorted(state, key=state.get)[: len(state) - STATE_MAX]:
            state.pop(k, None)
    try:
        os.makedirs(os.path.dirname(state_path), exist_ok=True)
        with open(state_path, "w", encoding="utf-8") as f:
            json.dump(state, f)
    except Exception:
        return  # cannot remember the strike -> allow
    sys.stderr.write(
        "[claude-ide bash-guard] BLOCKED (first attempt): " + reason + NL
        + guidance
        + "If this shell route is genuinely required, re-run the IDENTICAL command — it will" + NL
        + "pass (the acknowledgement is remembered for 24h). To disable this guard: remove the" + NL
        + "PreToolUse Bash entry in .claude/settings.json." + NL
    )
    sys.exit(2)


cmds_all = scan(cmd_str)
violations = []
for c in cmds_all:
    try:
        # Track `cd` so targets later in the SAME compound command resolve
        # against the directory the shell will actually be in. Without this,
        # "cd /outside && sed ... > file" resolved 'file' against the
        # project cwd and false-positived (observed live: a scratchpad
        # redirect denied as a project write). Last-cd-wins approximation.
        w = strip_wrappers(c["words"])
        if w and os.path.basename(w[0]) == "cd":
            t = resolve(w[1]) if len(w) > 1 else os.path.expanduser("~")
            if t:
                cwd = t
            continue
        eval_simple(c, violations)
    except Exception:
        pass

if not violations:
    # Pipe-exit-code advisory (deny-once): a likely-failing build/test
    # command piped into a filter reports the FILTER's exit status, so a
    # failed check can look green (observed live: cargo check erroring while
    # the tail said exit 0). One reminder per command — the identical retry
    # passes per the strike contract.
    for idx, c in enumerate(cmds_all):
        w = strip_wrappers(c["words"])
        if not c.get("piped_out") or not w:
            continue
        nxt = cmds_all[idx + 1] if idx + 1 < len(cmds_all) else None
        nw = strip_wrappers(nxt["words"]) if nxt else []
        if nw and os.path.basename(w[0]) in LIKELY_FAIL and os.path.basename(nw[0]) in PIPE_FILTERS:
            # ADVISORY, not a strike: this rule only ever had advice to give,
            # and a deny spent a whole round trip to deliver it — then the
            # identical retry ran the same masked pipeline anyway. Allowing
            # with additionalContext delivers the warning beside the output,
            # every time, at zero turn cost.
            advise("this ran '" + w[0] + "' piped into '" + nw[0] + "', so the exit status "
                   + "belongs to '" + nw[0] + "', NOT to '" + w[0] + "' — a failed build/check "
                   + "can look green this way. Judge success from the output itself, or re-run "
                   + "capturing the real code with echo " + chr(36) + "{pipestatus[1]} (zsh) / "
                   + "echo " + chr(36) + "{PIPESTATUS[1]} (bash), or redirect to a file and "
                   + "filter that file instead.")
            break
    sys.exit(0)

kind, subj, extra = violations[0]
rel = subj[len(project) + 1:] if isinstance(subj, str) and subj.startswith(project + "/") else subj
mcp = ""

if kind in ("redir", "inplace"):
    how = extra if extra else "shell redirection"
    strike("write", cmd_str,
           "this command writes '" + rel + "' through the shell (" + how + "),",
           "bypassing the IDE write-guard, syntax-guard, and authoring hooks." + NL
           + "Use the Write or Edit tool instead — they run those checks. Appending with '>>'" + NL
           + "is always allowed; only content-destroying writes are gated." + NL)
elif kind == "rm":
    what = " (" + extra + ")" if extra else ""
    strike("rm", cmd_str,
           "this recursively DELETES '" + rel + "' inside the project" + what + ",",
           "and permission prompts are disabled in this session, so this guard is the only brake." + NL
           + "If the user asked for exactly this deletion, re-run the identical command to proceed." + NL
           + "Otherwise, confirm with the user before deleting." + NL)
elif kind == "cat":
    if EMBEDDED:
        mcp = "  - MCP: get_section {path, symbol} for one function; search_code to locate things." + NL
    strike("cat", cmd_str,
           "'cat' would dump '" + rel + "' (" + extra + ") wholesale into context,",
           "which buries the part you need. Bounded alternatives:" + NL
           + "  - Read tool with offset/limit on the range you want." + NL
           + mcp
           + "  - grep '" + os.path.basename(str(rel)) + "' .claude-ide/repo-index.txt shows its section map (path Lstart-Lend symbol)." + NL)
elif kind == "symsearch":
    if EMBEDDED:
        mcp = "  - MCP: find_definition {symbol: '" + extra + "'} / find_references {symbol: '" + extra + "'} -> exact sites; search_code for concepts." + NL
    strike("symsearch", cmd_str,
           "shell '" + subj + "' for the identifier '" + extra + "' floods context with comment/doc false matches,",
           "The repo index answers this precisely — CHEAPEST ROUTE FIRST:" + NL
           + "  - ./.claude-ide/bin/find-def '" + extra + "' (or who-calls '" + extra + "')" + NL
           + "    one Bash call, nothing to load — same cost as the grep you just tried." + NL
           + "  - grep '" + extra + "' .claude-ide/repo-index.txt for a file's section map." + NL
           + mcp)
elif kind == "search":
    if EMBEDDED:
        mcp = "  - MCP: search_code {query} for concepts; find_definition / find_references for symbols." + NL
    strike("search", cmd_str,
           "recursive '" + subj + "' through the shell ignores .claudeignore and floods context,",
           "Better:" + NL
           + "  - Grep tool (structured output, respects ignores) for free text." + NL
           + mcp)
else:  # find
    if EMBEDDED:
        mcp = "  - MCP: find_file {query} resolves partial names to real paths." + NL
    strike("find", cmd_str,
           "shell 'find' walks the whole tree (node_modules included),",
           "Better:" + NL
           + "  - Glob tool with a pattern like **/name*.js." + NL
           + mcp)

sys.exit(0)
