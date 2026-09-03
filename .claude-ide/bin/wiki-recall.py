#!/usr/bin/env python3
"""
Wiki-recall UserPromptSubmit hook — auto-installed by Claude IDE.

When .claude/wiki.md is too large to inline at SessionStart (> INLINE_MAX
— the SessionStart hook emits only a TOC above that size), this hook
closes the gap: on every user prompt it scores wiki sections against the
prompt's keywords and prints the best matches to stdout, which Claude Code
adds to the model's context for this turn.

v2: per-session cooldown. Injected sections are remembered (keyed by
session + heading, with a body hash) in .claude-ide/.wiki-recall-state.json
and NOT re-injected for 30 minutes unless their content changed — on
focused work, every prompt used to re-inject the same ~8KB. The global
PreCompact hook deletes the state file, so after compaction (which wipes
the earlier injection from context) sections become eligible again
immediately. Each section is tagged with its wiki.md line number so the
model can Read the full section if the clip isn't enough.

v3: supersedence + stemming. A section whose first lines contain
"SUPERSEDED" (the wiki convention for an entry invalidated by a later
one) is NEVER injected — recalling a reverted decision is worse than
recalling nothing, and the correcting entry shares the same keywords so
it surfaces instead. Prompt and wiki words are matched on a crude
symmetric stem (bake/baked/bakes/baking all key as "bak"), so plain
morphology can't hide a match.

v5: author-curated aliases. A section may carry an HTML comment near its
top — "aliases: multi choice, model switch" comment-style — whose words
score at heading weight (x3). Headings drift toward precise jargon
("AskUserQuestion confirm gate") while real prompts use plain words
("the multi choice when switching models"); aliases bridge that gap.
Verified miss this closed: a model-switch bug prompt recalled zero of
the three AskUserQuestion entries that governed the fix.

INLINE_MAX must stay in sync with the SessionStart hook in the IDE's
setup.rs — both sides of the "inline vs TOC+recall" split key off it.

Silent (exit 0, no output) when the wiki is missing or small enough to be
fully inlined, the prompt is too short, or nothing scores above threshold.
Threshold must stay conservative — irrelevant injections are worse than
missed ones.
"""
import hashlib, json, os, re, sys, time

INLINE_MAX = 6500   # bytes; MUST match setup.rs (SessionStart inlines wikis <= this)
COOLDOWN = 1800     # seconds; do not re-inject an unchanged section more often
STATE_TTL = 172800  # prune state entries older than 48h

WORD = re.compile(r"[a-zA-Z_][a-zA-Z0-9_-]{3,}")
STOP = {
    "this", "that", "with", "from", "have", "what", "when", "where", "which",
    "should", "could", "would", "there", "their", "about", "make", "made",
    "like", "just", "also", "then", "than", "them", "they", "your", "please",
    "need", "want", "does", "doesnt", "dont", "into", "only", "some", "more",
    "file", "files", "code", "using", "after", "before", "work", "working",
}

def stem(w):
    # Crude but SYMMETRIC: strip one plural/gerund/past/trailing-e suffix
    # when a >=3-char stem remains. Applied to both prompt and wiki, so a
    # conflation can only ever add a candidate match, never lose one.
    for suf in ("ing", "ed", "es", "s", "e"):
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            return w[: len(w) - len(suf)]
    return w

def words_of(text):
    return {stem(w) for w in (m.group(0).lower() for m in WORD.finditer(text)) if w not in STOP}

# v4: file-aware recall. The strongest signal for "which durable constraint
# applies" is the FILE being worked on, not prompt vocabulary — a landmine
# like "PTY spawns through login shell" should surface when you touch pty.rs
# even if your prompt says "terminal spawn". Wiki bodies are full of concrete
# filenames; we extract basenames from the prompt and from each section, and
# a section that references a prompt-named file gets a strong score boost.
# NOTE: NO backslashes anywhere (this whole script is a JS template literal —
# a backslash escape would corrupt it); the split uses a char class only.
FILE_EXTS = frozenset((
    "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rs", "go", "rb", "php",
    "java", "kt", "c", "h", "cpp", "cc", "cs", "css", "scss", "sass", "less",
    "html", "htm", "vue", "svelte", "astro", "json", "toml", "yml", "yaml",
    "sql", "sh", "zsh", "bash", "lua", "dm", "dmm", "dme", "rsi", "dmi",
    "png", "jpg", "jpeg", "gif", "webp", "svg", "glb", "gltf", "fbx",
    "mp3", "wav", "ogg", "mp4", "webm", "md",
))

def files_of(text):
    # Basenames like canvas.js / pty.rs, lowercased. Splits on anything
    # that is not a path char, then keeps tokens ending in a known extension.
    out = set()
    for tok in re.split("[^A-Za-z0-9_./-]+", text):
        # Strip trailing dots — prose ends sentences on a filename
        # ("...lives in pty.rs.") and the sentence period would otherwise
        # become the "extension". Leading dots too (harmless for dotfiles).
        base = tok.rsplit("/", 1)[-1].strip(".")
        dot = base.rfind(".")
        if dot > 0 and base[dot + 1:].lower() in FILE_EXTS:
            out.add(base.lower())
    return out

def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    if not isinstance(data, dict):
        return
    prompt = str(data.get("prompt") or "")
    project = os.environ.get("CLAUDE_PROJECT_DIR") or str(data.get("cwd") or "")
    if not project:
        return
    wiki = os.path.join(project, ".claude", "wiki.md")
    try:
        if os.path.getsize(wiki) <= INLINE_MAX:
            return  # small wikis are fully inlined at SessionStart already
        with open(wiki, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return

    pwords = words_of(prompt)
    pfiles = files_of(prompt)
    # A file-only prompt ("fix pty.rs") has too few real words for the >=2
    # gate but a strong file signal — keep it. Require enough words OR a file.
    if len(pwords) < 2 and not pfiles:
        return

    # Split into sections at ## / ### headings (a top-level # is the title),
    # tracking each section's 1-based start line for the [wiki.md LNN] tag.
    sections = []
    head, lines, start = None, [], 0
    for i, line in enumerate(text.splitlines(), 1):
        if re.match(r"^#{2,3} ", line):
            if head is not None:
                sections.append((start, head, lines))
            head, lines, start = line, [], i
        lines.append(line)
    if head is not None:
        sections.append((start, head, lines))

    scored = []
    for start, head, lines in sections:
        body = chr(10).join(lines)
        if "SUPERSEDED" in body[:300]:
            continue  # invalidated entry — the correcting entry matches instead
        # File governance is the precise signal: a section that references a
        # file named in the prompt gets a strong boost (6 each) — enough to
        # clear the threshold on the file match ALONE, even with zero word
        # overlap. This is what surfaces "PTY spawns through login shell" for
        # a prompt about pty.rs whose wording never matches the heading.
        fmatch = len(pfiles & files_of(body)) if pfiles else 0
        # Author-curated aliases (v5): an "<!-- aliases: a, b -->" comment in
        # the section's first ~600 bytes contributes words at heading weight.
        am = re.search("<!-- *aliases *: *([^>]*)-->", body[:600])
        awords = words_of(am.group(1)) if am else set()
        score = 3 * len(pwords & (words_of(head) | awords)) + len(pwords & words_of(body)) + 6 * fmatch
        if score >= 3:
            scored.append((score, start, head, body))
    if not scored:
        return
    scored.sort(key=lambda t: -t[0])

    # Cooldown state: skip sections injected recently in THIS session whose
    # content hasn't changed. All state IO is best-effort.
    sid = str(data.get("session_id") or "global")
    state_path = os.path.join(project, ".claude-ide", ".wiki-recall-state.json")
    state = {}
    try:
        with open(state_path, encoding="utf-8") as f:
            state = json.load(f) or {}
        if not isinstance(state, dict):
            state = {}
    except Exception:
        state = {}
    now = time.time()
    state = {k: v for k, v in state.items()
             if isinstance(v, dict) and now - v.get("t", 0) < STATE_TTL}

    # Cooldown filters WITHIN the top-3 (not "take the next 3 eligible") —
    # a repeated prompt goes silent instead of drip-feeding weaker matches.
    picked = []
    for score, start, head, body in scored[:3]:
        key = hashlib.sha1((sid + "|" + head).encode("utf-8", "replace")).hexdigest()
        bh = hashlib.sha1(body.encode("utf-8", "replace")).hexdigest()
        prev = state.get(key)
        if prev and prev.get("h") == bh and now - prev.get("t", 0) < COOLDOWN:
            continue  # still in context from a recent prompt — don't re-burn tokens
        picked.append((start, head, body, key, bh))
    if not picked:
        return

    out, total = [], 0
    SECTION_CAP = 600  # per-section body bytes — the scorer already reads ~600;
    # a long entry (models bloat entries past the wiki's own "1-4 lines" rule)
    # must not burn the model's budget on one injection.
    for start, head, body, key, bh in picked:
        clipped = body[: min(SECTION_CAP, max(0, 8000 - total))]
        if not clipped:
            break
        if len(body) > len(clipped):
            clipped += chr(10) + "(truncated — Read .claude/wiki.md at L" + str(start) + " for the full section)"
        out.append("[wiki.md L" + str(start) + "]" + chr(10) + clipped)
        total += len(clipped)
        state[key] = {"h": bh, "t": now}
    if not out:
        return
    try:
        os.makedirs(os.path.dirname(state_path), exist_ok=True)
        with open(state_path, "w", encoding="utf-8") as f:
            json.dump(state, f)
    except Exception:
        pass
    sep = chr(10) * 2 + "---" + chr(10) * 2
    print("Wiki recall — sections of .claude/wiki.md matching this prompt. "
          "These are durable project decisions/constraints; do not violate them. "
          "(Each is tagged with its wiki.md line — Read there for the full section.)")
    print()
    print(sep.join(out))

main()
