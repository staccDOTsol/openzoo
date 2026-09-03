#!/usr/bin/env python3
"""
File-recall UserPromptSubmit hook — auto-installed by Claude IDE.

When the prompt names a concrete file ("edit image.png", "look at
canvas.js"), inject a compact context card for it BEFORE the model acts:
the resolved project path (kills path-guessing — the top lite-model
failure), what kind of file it is, image dimensions / DMI-RSI state names,
line count for text files with the >500-line section discipline attached,
sibling files that look like its source (image.aseprite next to image.png),
and an explicit AMBIGUOUS warning when several files share the basename.

Everything on the card is computed LIVE at prompt time (stat + header
parse per hit), so it can never go stale. The only cached artifact is the
project file LIST (.claude-ide/.file-list-cache.txt, 120s TTL, rebuilt
inline on a resolution miss), because walking a big tree on every prompt
would tax prompt latency.

Push vs pull: the MCP tools (find_file, get_section, list_assets) are
pull — the model must think to ask. A literal filename in the prompt is a
precise enough trigger to justify push. Silent when no token resolves;
output hard-capped at ~1800 bytes.

v2: absolute paths OUTSIDE the project (dragged screenshots, downloads)
get a live-stat card too: EXISTS + kind/dims/size, or "does NOT exist" —
plus warnings for the two macOS traps that send models into retry
spirals: exotic-space filename bytes (U+202F before AM/PM in screenshot
names) and ephemeral, unlistable NSIRD/.TemporaryItems paths.

Fail-open: any internal error exits 0 silently.
"""
import json, os, struct, sys, time, zlib

NL = chr(10)
BS = chr(92)
CACHE_TTL = 120
MAX_FILES = 30000
MAX_OUT = 1800
MAX_TOKENS = 4
MAX_MATCHES = 3
MAX_EXTERNAL = 2
BIG_LINES = 500
MAX_TEXT_BYTES = 8000000

# Exotic whitespace that macOS bakes into filenames (Screenshot.app puts a
# narrow no-break space before AM/PM) — a hand-retyped regular space will
# never match these bytes.
EXOTIC_SPACES = {chr(8239): "U+202F narrow no-break space",
                 chr(160): "U+00A0 no-break space"}
# macOS drag-out-of-screenshot-thumbnail temp locations: ephemeral (deleted
# when the thumbnail dismisses) AND unlistable (deny-ACL directories).
TMP_HINTS = (".TemporaryItems", "NSIRD_")

CODE_EXTS = {
    "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "py", "rs", "go", "rb",
    "php", "java", "kt", "c", "h", "cpp", "hpp", "cc", "cs", "css", "scss",
    "sass", "less", "html", "htm", "vue", "svelte", "astro", "md", "toml",
    "yml", "yaml", "sql", "sh", "zsh", "bash", "lua", "dm", "dmm", "dme",
    "txt", "xml", "svg", "csv",
}
ASSET_EXTS = {
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "dmi", "rsi",
    "mp3", "wav", "ogg", "flac", "mp4", "webm", "mov", "avi",
    "glb", "gltf", "fbx", "obj", "blend", "pdf", "ttf", "otf", "woff",
    "woff2", "aseprite", "ase", "psd", "kra", "xcf", "rsc",
}
KNOWN_EXTS = CODE_EXTS | ASSET_EXTS
SOURCE_OF = {"aseprite", "ase", "psd", "kra", "xcf", "svg", "blend", "fla"}
SKIP_DIRS = {"node_modules", ".git", "dist", "build", "out", "target",
             "__pycache__", ".next", ".nuxt", ".cache", "vendor", "coverage",
             ".claude-ide", ".venv", "venv", "tmp", "DerivedData"}

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not isinstance(data, dict):
    sys.exit(0)
prompt = str(data.get("prompt") or "")
project = os.environ.get("CLAUDE_PROJECT_DIR") or str(data.get("cwd") or "")
if not prompt or not project or not os.path.isdir(project):
    sys.exit(0)
project = os.path.realpath(project)


def ext_of(name):
    i = name.rfind(".")
    return name[i + 1:].lower() if i > 0 else ""


def prompt_tokens(text):
    """Filename-looking tokens: contain a dot with a known extension, or a
    path separator + known extension. Manual scan — no regex needed."""
    toks, cur = [], []
    ok_chars = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._/-")
    for ch in text:
        if ch in ok_chars:
            cur.append(ch)
        else:
            if cur:
                toks.append("".join(cur))
                cur = []
    if cur:
        toks.append("".join(cur))
    out, seen = [], set()
    for t in toks:
        t = t.strip("./-")
        if len(t) < 4 or "." not in t or "://" in t:
            continue
        if ext_of(t) not in KNOWN_EXTS:
            continue
        low = t.lower()
        if low in seen:
            continue
        seen.add(low)
        out.append(t)
        if len(out) >= MAX_TOKENS:
            break
    return out


def external_paths(text):
    """Absolute paths in the prompt — quoted ("/a b/c.png"), shell-escaped
    (/a\\ b/c.png — BS+space), or bare — including exotic-space bytes kept
    verbatim. Manual scan (no regex; this file is embedded in a JS template
    literal where backslash escapes are landmines). Returns byte-exact
    candidates, deduped, order preserved."""
    out, seen = [], set()
    n = len(text)
    i = 0
    while i < n:
        ch = text[i]
        if ch != "/":
            i += 1
            continue
        prev = text[i - 1] if i > 0 else ""
        quoted = prev in ("'", chr(34))
        # A path starts at start-of-text, after whitespace, or after a quote.
        if prev and not quoted and not prev.isspace():
            i += 1
            continue
        cur = []
        j = i
        while j < n:
            c = text[j]
            if quoted:
                if c == prev:
                    break
                cur.append(c)
                j += 1
                continue
            if c == BS and j + 1 < n and text[j + 1] == " ":
                cur.append(" ")  # shell-escaped space -> literal space
                j += 2
                continue
            if c == NL or c == chr(9) or c == " ":
                break
            if c in ("'", chr(34), ")", "]", "}", ",", ";"):
                break
            cur.append(c)
            j += 1
        p = "".join(cur).rstrip(".:!?")
        i = j + 1
        if len(p) < 6 or p.count("/") < 2 or "://" in p:
            continue
        if p in seen:
            continue
        seen.add(p)
        out.append(p)
    return out


def external_card(p):
    """Context card for an absolute path OUTSIDE the project: verified
    live existence, kind/size, and the two macOS traps (exotic-space
    filename bytes, ephemeral unlistable screenshot temp dirs) that
    otherwise send the model into a retry spiral."""
    exotic = sorted(set(name for ch, name in EXOTIC_SPACES.items() if ch in p))
    is_tmp = any(h in p for h in TMP_HINTS)
    bits = []
    if os.path.exists(p):
        e = ext_of(os.path.basename(p))
        if os.path.isdir(p):
            bits.append("EXISTS (outside project): directory")
        else:
            try:
                size = os.path.getsize(p)
            except OSError:
                size = 0
            d = png_dims(p) if e == "png" else (gif_dims(p) if e == "gif" else None)
            bits.append("EXISTS (outside project): " + (e.upper() + " " if e else "")
                        + (str(d[0]) + "x" + str(d[1]) + ", " if d else "") + human(size))
        if exotic:
            bits.append("filename contains " + ", ".join(exotic)
                        + " — pass these EXACT bytes to tools; a retyped plain space will NOT match")
        if is_tmp:
            bits.append("macOS screenshot TEMP path — ephemeral (gone when the thumbnail "
                        + "dismisses) and its folder is unlistable (ls/find/glob: 'Operation "
                        + "not permitted'); if needed beyond this turn, copy it out NOW")
    else:
        bits.append("does NOT exist (checked just now)")
        if is_tmp:
            bits.append("NSIRD/.TemporaryItems screenshot temp paths die when the floating "
                        + "thumbnail is dismissed — do NOT retry/search that folder (it is "
                        + "unlistable); ask the user to re-drag or check their screenshots dir")
        elif exotic:
            bits.append("path contains " + ", ".join(exotic)
                        + " — if it was hand-typed, the exotic space is the likely mismatch")
    return "- " + p + " — " + "; ".join(bits)


def walk_project():
    files = []
    for root, dirs, names in os.walk(project):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not (d.startswith(".") and d not in (".claude",))]
        for n in names:
            rel = os.path.relpath(os.path.join(root, n), project)
            files.append(rel)
            if len(files) >= MAX_FILES:
                return files
        # .rsi folders count as files for resolution purposes
        for d in dirs:
            if d.lower().endswith(".rsi"):
                files.append(os.path.relpath(os.path.join(root, d), project))
    return files


def file_list():
    cache = os.path.join(project, ".claude-ide", ".file-list-cache.txt")
    try:
        if os.path.isfile(cache) and time.time() - os.path.getmtime(cache) < CACHE_TTL:
            with open(cache, encoding="utf-8", errors="replace") as f:
                lines = [l.rstrip(NL) for l in f]
            if lines:
                return lines, False
    except OSError:
        pass
    files = walk_project()
    try:
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        with open(cache, "w", encoding="utf-8") as f:
            f.write(NL.join(files))
    except OSError:
        pass
    return files, True


def resolve(token, files):
    """Exact basename, then case-insensitive basename, then path-suffix."""
    tl = token.lower()
    base_hits = [p for p in files if os.path.basename(p) == token]
    if not base_hits:
        base_hits = [p for p in files if os.path.basename(p).lower() == tl]
    if not base_hits and "/" in token:
        base_hits = [p for p in files if p.lower().endswith(tl)]
    return base_hits[:MAX_MATCHES + 1]


def png_dims(path):
    try:
        with open(path, "rb") as f:
            head = f.read(33)
        if len(head) >= 24 and head[0] == 137 and head[1:4] == b"PNG" and head[12:16] == b"IHDR":
            w, h = struct.unpack(">II", head[16:24])
            return w, h
    except Exception:
        pass
    return None


def gif_dims(path):
    try:
        with open(path, "rb") as f:
            head = f.read(10)
        if head[:3] == b"GIF":
            w, h = struct.unpack("<HH", head[6:10])
            return w, h
    except Exception:
        pass
    return None


def dmi_states(path):
    """DMI = PNG with a zTXt 'Description' chunk holding state metadata."""
    try:
        with open(path, "rb") as f:
            blob = f.read(2000000)
        if not (blob and blob[0] == 137 and blob[1:4] == b"PNG"):
            return None
        i = 8
        while i + 8 <= len(blob):
            (ln,) = struct.unpack(">I", blob[i:i + 4])
            typ = blob[i + 4:i + 8]
            if typ == b"zTXt":
                payload = blob[i + 8:i + 8 + ln]
                z = payload.find(bytes([0]))
                if z >= 0:
                    text = zlib.decompress(payload[z + 2:]).decode("utf-8", "replace")
                    states, cell = [], ""
                    for line in text.splitlines():
                        line = line.strip()
                        if line.startswith("state ="):
                            parts = line.split(chr(34))
                            if len(parts) >= 2:
                                states.append(parts[1])
                        elif line.startswith("width ="):
                            cell = line.split("=")[-1].strip()
                        elif line.startswith("height =") and cell:
                            cell = cell + "x" + line.split("=")[-1].strip()
                    return states, cell
            if typ == b"IEND":
                break
            i += 12 + ln
    except Exception:
        pass
    return None


def rsi_meta(path):
    try:
        with open(os.path.join(path, "meta.json"), encoding="utf-8", errors="replace") as f:
            meta = json.load(f)
        size = meta.get("size") or {}
        states = [str(s.get("name", "?")) for s in meta.get("states") or []]
        cell = str(size.get("x", "?")) + "x" + str(size.get("y", "?"))
        return states, cell
    except Exception:
        return None


def human(n):
    if n < 1024:
        return str(n) + "B"
    kb = n / 1024.0
    if kb < 1024:
        return str(round(kb, 1)) + "KB"
    return str(round(kb / 1024.0, 1)) + "MB"


def state_note(res):
    if not res:
        return ""
    states, cell = res
    shown = ", ".join(states[:6]) + (", …" if len(states) > 6 else "")
    return ("cell " + cell + ", " if cell else "") + str(len(states)) + " state(s): " + shown


def card(rel, files):
    full = os.path.join(project, rel)
    e = ext_of(os.path.basename(rel))
    bits = []
    if os.path.isdir(full):
        if e == "rsi":
            note = state_note(rsi_meta(full))
            bits.append("RSI sprite folder" + (", " + note if note else ""))
        else:
            bits.append("directory")
    elif os.path.isfile(full):
        try:
            size = os.path.getsize(full)
        except OSError:
            size = 0
        if e == "dmi":
            note = state_note(dmi_states(full))
            d = png_dims(full)
            bits.append("DMI spritesheet" + (" PNG " + str(d[0]) + "x" + str(d[1]) if d else "")
                        + (", " + note if note else "") + ", " + human(size))
        elif e in ("png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"):
            d = png_dims(full) if e == "png" else (gif_dims(full) if e == "gif" else None)
            bits.append(e.upper() + (" " + str(d[0]) + "x" + str(d[1]) if d else "") + ", " + human(size))
        elif e in CODE_EXTS and size <= MAX_TEXT_BYTES:
            try:
                with open(full, encoding="utf-8", errors="replace") as f:
                    n_lines = sum(1 for _ in f)
                if n_lines > BIG_LINES:
                    bits.append(str(n_lines) + " lines — big file: use get_section {path, symbol} or Read offset/limit, not a whole-file read")
                else:
                    bits.append(str(n_lines) + " lines")
            except OSError:
                bits.append(human(size))
        else:
            bits.append((e.upper() + ", " if e else "") + human(size))
        stem = os.path.basename(rel)
        stem = stem[: stem.rfind(".")] if "." in stem else stem
        rel_dir = os.path.dirname(rel)
        sibs = []
        for p in files:
            if os.path.dirname(p) != rel_dir or p == rel:
                continue
            b = os.path.basename(p)
            s = b[: b.rfind(".")] if "." in b else b
            if s == stem:
                sibs.append(b)
        srcs = [s for s in sibs if ext_of(s) in SOURCE_OF]
        if srcs:
            bits.append("likely source: " + ", ".join(srcs[:2]))
        elif sibs:
            bits.append("related: " + ", ".join(sorted(sibs)[:3]))
    else:
        return None
    return "- " + rel + " — " + "; ".join(bits)


def main():
    # External absolute paths first — they need no file list, and a missing/
    # trapped path warning is the highest-value card this hook can emit
    # (it preempts a Read-fail → ls-fail → find-fail retry spiral).
    ext_cards = []
    for p in external_paths(prompt):
        rp = os.path.realpath(p) if os.path.exists(p) else os.path.normpath(p)
        if rp == project or rp.startswith(project + "/"):
            continue  # in-project files are handled by token resolution below
        ext_cards.append(external_card(p))
        if len(ext_cards) >= MAX_EXTERNAL:
            break
    out = []
    tokens = prompt_tokens(prompt)
    if not tokens and not ext_cards:
        return
    files, fresh = file_list() if tokens else ([], True)
    if tokens and not files:
        tokens = []
    for t in tokens:
        hits = resolve(t, files)
        if not hits and not fresh:
            # Cache miss on a stale list: the file may be brand-new. Rebuild
            # the list once for this prompt and retry.
            files[:] = walk_project()
            fresh = True
            hits = resolve(t, files)
        if not hits:
            continue
        if len(hits) > 1:
            alts = []
            for h in hits[:MAX_MATCHES]:
                c = card(h, files)
                if c:
                    alts.append(c[2:])
            if alts:
                out.append("- AMBIGUOUS '" + t + "' matches " + str(len(hits))
                           + " files — name the one you mean:" + NL + "    " + (NL + "    ").join(alts))
            continue
        c = card(hits[0], files)
        if c:
            out.append(c)
    out.extend(ext_cards)
    if not out:
        return
    text = NL.join(out)
    if len(text) > MAX_OUT:
        text = text[:MAX_OUT] + "…"
    print("File context (auto-resolved from this prompt — paths verified on disk; "
          "no need to find_file these):")
    print(text)


try:
    main()
except Exception:
    pass
sys.exit(0)
