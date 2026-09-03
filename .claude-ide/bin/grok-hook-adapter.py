#!/usr/bin/env python3
"""
Grok → Claude harness hook adapter — auto-installed by Claude IDE.

Grok Build sends camelCase hook events (toolName / toolInput / sessionId)
and uses its own tool names (run_terminal_command, read_file, write,
search_replace, grep). The harness scripts under .claude-ide/bin/ were
written for Claude Code (tool_name / tool_input / Bash / Read / Write /
Edit / Grep). This adapter:

  1. Reads the event JSON from stdin
  2. Normalizes field names + tool names to the Claude shape
  3. Runs the target harness script with the normalized payload
  4. Forwards stdout/stderr and exit code (Grok honors exit 2 as deny;
     also emits {"decision":"deny","reason":...} JSON for belt-and-suspenders)

Fail-open: any adapter-level error exits 0 so a broken adapter never
blocks the model. Invoked as:

  python3 grok-hook-adapter.py /abs/path/to/script.py
"""
import json, os, subprocess, sys

# Grok (and Cursor) tool names → Claude Code names the harness scripts check.
TOOL_ALIAS = {
    "run_terminal_command": "Bash",
    "run_terminal_cmd": "Bash",
    "read_file": "Read",
    "write": "Write",
    "search_replace": "Edit",
    "grep": "Grep",
    "list_dir": "Glob",
    "web_search": "WebSearch",
    "web_fetch": "WebFetch",
    "spawn_subagent": "Task",
    "todo_write": "TodoWrite",
}

def normalize(data):
    if not isinstance(data, dict):
        return {}
    out = dict(data)

    tool = out.get("tool_name") or out.get("toolName") or ""
    tool = TOOL_ALIAS.get(tool, tool)
    out["tool_name"] = tool

    ti = out.get("tool_input") or out.get("toolInput") or {}
    if not isinstance(ti, dict):
        ti = {}
    ti = dict(ti)

    # Path field aliases (Grok read_file uses target_file).
    path = (
        ti.get("file_path")
        or ti.get("target_file")
        or ti.get("path")
        or ""
    )
    if path and not ti.get("file_path"):
        ti["file_path"] = path

    out["tool_input"] = ti

    # UserPromptSubmit / session identity.
    if not out.get("prompt"):
        out["prompt"] = (
            out.get("promptText")
            or out.get("userPrompt")
            or out.get("message")
            or ""
        )
    if not out.get("session_id"):
        out["session_id"] = out.get("sessionId") or out.get("session_id") or ""
    if not out.get("cwd"):
        out["cwd"] = (
            out.get("cwd")
            or out.get("workspaceRoot")
            or os.environ.get("CLAUDE_PROJECT_DIR")
            or os.environ.get("GROK_WORKSPACE_ROOT")
            or ""
        )
    return out

def main():
    if len(sys.argv) < 2:
        sys.exit(0)
    script = sys.argv[1]
    if not os.path.isabs(script):
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), script)
    if not os.path.isfile(script):
        sys.exit(0)

    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        data = {}

    try:
        payload = json.dumps(normalize(data)).encode("utf-8")
        p = subprocess.run(
            [sys.executable, script],
            input=payload,
            capture_output=True,
        )
    except Exception:
        sys.exit(0)

    if p.stdout:
        sys.stdout.buffer.write(p.stdout)
    if p.stderr:
        sys.stderr.buffer.write(p.stderr)

    # Grok: exit 2 = explicit deny. Also print decision JSON so either
    # protocol path blocks the tool call.
    if p.returncode == 2:
        if b'"decision"' not in (p.stdout or b""):
            reason = (p.stderr or b"").decode("utf-8", "replace").strip()
            if not reason:
                reason = "blocked by claude-ide harness"
            # Cap reason size so a huge parse dump can't blow the channel.
            if len(reason) > 4000:
                reason = reason[:4000] + "…"
            try:
                sys.stdout.write(json.dumps({"decision": "deny", "reason": reason}) + "\n")
            except Exception:
                pass
        sys.exit(2)
    sys.exit(p.returncode if p.returncode is not None else 0)

if __name__ == "__main__":
    main()
