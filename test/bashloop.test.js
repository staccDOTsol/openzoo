import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBashBody, grepFingerprint, nearIdenticalBash,
  looksLikeDirectiveAsBash, isFailedExecOutput, looksLikeGrepIds,
  hasCompileArtifact, extractLastBashCommand, extractLastBashStdout,
  countNearIdenticalBashRuns, createBashLoopTracker, bashStopText,
} from '../lib/bashloop.js';

test('WRITE:/READ: as bash is a harness directive, not a shell command', () => {
  assert.equal(looksLikeDirectiveAsBash('WRITE:5d_chess.py'), true);
  assert.equal(looksLikeDirectiveAsBash('WRITE: 5d_chess.py | print("hi")'), true);
  assert.equal(looksLikeDirectiveAsBash('READ: Cargo.toml'), true);
  assert.equal(looksLikeDirectiveAsBash('ls -la'), false);
  assert.equal(looksLikeDirectiveAsBash('python -c "print(1)"'), false);
});

test('command not found and syntax error are failed execs', () => {
  assert.equal(isFailedExecOutput('WRITE:5d_chess.py: command not found\n(exit 127)'), true);
  assert.equal(isFailedExecOutput('  File "<string>", line 1\n    print(\nSyntaxError: unexpected EOF'), true);
  assert.equal(isFailedExecOutput('/bin/bash: line 1: syntax error near unexpected token'), true);
  assert.equal(isFailedExecOutput('ok\ncompiled fate.so'), false);
});

test('near-identical greps for declare_id share a fingerprint', () => {
  const a = 'grep -n declare_id programs/fate/src/lib.rs';
  const b = 'rg -n declare_id programs/fate/src/lib.rs';
  const c = 'grep -R declare_id .';
  assert.equal(grepFingerprint(a), grepFingerprint(b));
  assert.equal(nearIdenticalBash(a, c), true);
  assert.equal(nearIdenticalBash(a, 'ls target/release'), false);
});

test('identical Bash/grep is not paid/executed more than twice — previous stdout + stop', () => {
  const t = createBashLoopTracker({ maxRuns: 2 });
  const cmd = 'grep -n declare_id programs/fate/src/lib.rs';
  const sid = 'cust-1';
  t.note(sid, cmd, 'programs/fate/src/lib.rs:12: declare_id!("…");');
  t.note(sid, cmd, 'programs/fate/src/lib.rs:12: declare_id!("…");');
  const third = t.decide(sid, cmd, { stdout: 'programs/fate/src/lib.rs:12: declare_id!("…");' });
  assert.equal(third.stop, true);
  assert.match(third.text, /same Bash\/grep ran twice/);
  assert.match(third.text, /declare_id/);
  assert.equal(t.decide(sid, 'cargo build --release').stop, false);
});

test('after a compile artifact, declare_id greps stop', () => {
  const t = createBashLoopTracker({ maxRuns: 2 });
  const sid = 'fate';
  const msgs = [
    { role: 'user', content: 'ship fate.so' },
    { role: 'tool', content: '   Compiling fate\n    Finished release\ntarget/sbpf-solana-solana/release/fate.so' },
  ];
  assert.equal(hasCompileArtifact(msgs), true);
  t.markArtifact(sid);
  const grep = t.decide(sid, 'grep -n declare_id programs/fate/src/lib.rs', { messages: msgs });
  assert.equal(grep.stop, true);
  assert.equal(grep.reason, 'compile-artifact');
  assert.match(grep.text, /compile artifact already exists/);
});

test('history with two Bash tool_uses of the same grep stops the third', () => {
  const t = createBashLoopTracker({ maxRuns: 2 });
  const cmd = 'rg declare_id programs';
  const messages = [
    {
      role: 'assistant',
      tool_calls: [{ function: { name: 'Bash', arguments: JSON.stringify({ command: cmd }) } }],
    },
    { role: 'tool', content: 'src/lib.rs:1: declare_id!("abc");' },
    {
      role: 'assistant',
      tool_calls: [{ function: { name: 'Bash', arguments: JSON.stringify({ command: 'grep -n declare_id programs/lib.rs' }) } }],
    },
    { role: 'tool', content: 'src/lib.rs:1: declare_id!("abc");' },
  ];
  assert.ok(countNearIdenticalBashRuns(messages, cmd) >= 2);
  const d = t.decide('s', cmd, { messages });
  assert.equal(d.stop, true);
  assert.match(extractLastBashStdout(messages), /declare_id/);
  assert.equal(extractLastBashCommand(messages), 'grep -n declare_id programs/lib.rs');
});

test('normalizeBashBody collapses whitespace', () => {
  assert.equal(normalizeBashBody('grep   -n\tdeclare_id  x'), 'grep -n declare_id x');
  assert.match(bashStopText('out', 'repeat'), /same Bash\/grep ran twice/);
});
