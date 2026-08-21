import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);

function packedOccTree() {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-agent-pack-'));
  const exe = path.join(dir, 'openzoo');
  const resources = path.join(dir, 'resources');
  const claude = path.join(resources, 'openzoo-claude');
  mkdirSync(path.join(claude, 'v2', 'src', 'ui'), { recursive: true });
  writeFileSync(exe, '');
  writeFileSync(path.join(claude, 'package.json'), JSON.stringify({
    name: 'openzoo-claude', version: '2.0.2',
    bin: { 'openzoo-claude': 'v2/src/index.mjs' },
  }));
  writeFileSync(path.join(claude, 'v2', 'src', 'index.mjs'), 'export {}\n');
  writeFileSync(path.join(claude, 'v2', 'src', 'goal.mjs'), 'export {}\n');
  writeFileSync(path.join(claude, 'v2', 'src', 'ui', 'commands.mjs'), 'export { goal: true }\n');
  return { dir, exe, resources, claude };
}

test('writeAgentPtyLine: ready slash is line+CR; busy slash Esc-then-line; hi is immediate', async () => {
  const uiPort = 24800 + Math.floor(Math.random() * 2000);
  const home = mkdtempSync(path.join(tmpdir(), 'oz-agent-home-'));
  const packed = packedOccTree();
  process.env.HOME = home;
  process.env.OZ_GROKUI_PORT = String(uiPort);
  process.env.OZ_AGENT_PORTS = '0';
  const {
    newThread, ensureAgentPty, killAgentPty, setAgentPtySpawnerForTest,
    writeAgentPtyLine, ptyLooksReady, agentPtySpawnSpec, handleSlash, isGrokuiOwnedSlash, CLAUDE_SLASH_IN_AUTO,
  } = await import(path.join(root, 'lib/grokui.mjs'));

  assert.equal(CLAUDE_SLASH_IN_AUTO.has('goal'), true);
  assert.equal(CLAUDE_SLASH_IN_AUTO.has('model'), true);
  assert.equal(isGrokuiOwnedSlash('/goal', 'agent'), false);
  assert.equal(isGrokuiOwnedSlash('/model opus', 'agent'), false);
  assert.equal(isGrokuiOwnedSlash('/tier grok4.6', 'agent'), true);

  const spec = agentPtySpawnSpec({
    env: {
      HOME: path.join(packed.dir, 'no-home'),
      OZ_PACKED_RESOURCES: packed.resources,
      PATH: '/usr/bin',
    },
    execPath: packed.exe,
  });
  assert.ok(spec);
  assert.equal(spec.via, 'packed');
  assert.equal(spec.command, packed.exe);
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(spec.env.ANTHROPIC_API_KEY, undefined);
  assert.match(spec.env.ANTHROPIC_BASE_URL, /127\.0\.0\.1:\d+\/v1/);
  assert.equal(spec.env.TERM, 'xterm-256color');
  assert.equal(spec.env.COLORTERM, 'truecolor');
  assert.equal(spec.env.FORCE_COLOR, '3');
  assert.match(spec.env.LANG, /utf-8/i);
  assert.match(spec.env.CLAUDE_CONFIG_DIR, /\.claude$/);
  assert.ok(spec.args[0].includes('openzoo-claude'));
  assert.ok(!spec.args.includes('openzoo/auto'));
  assert.ok(!spec.args.includes('--append-system-prompt'), 'empty system on packed occ spawn');

  let spawns = 0;
  const writes = [];
  let growOnEsc = null;
  setAgentPtySpawnerForTest((_spec) => {
    spawns += 1;
    return {
      write: (s) => {
        writes.push(s);
        if (s === ESC && typeof growOnEsc === 'function') growOnEsc();
      },
      resize: () => {},
      onData: () => {},
      onExit: () => {},
      kill: () => {},
    };
  });

  const t = newThread('agent-reuse', null);
  assert.equal(t.runMode, 'agent');
  const a = ensureAgentPty(t);
  const b = ensureAgentPty(t);
  assert.ok(a);
  assert.equal(a, b);
  assert.equal(spawns, 1);
  t.dir = path.join(home, 'other-cwd');
  const c = ensureAgentPty(t);
  assert.equal(c, a, 'cwd mismatch must not respawn');
  assert.equal(spawns, 1);

  a.buf = Buffer.from('> ');
  assert.equal(ptyLooksReady(a), true);

  await handleSlash('/tier grok4.6', t);
  assert.equal(t.tier, 'grok4.6');
  assert.equal(writes[0], '/model x-ai/grok-4.6' + CR, 'ready slash: no ESC before /model');
  assert.ok(!writes.includes(ESC), 'ready /tier must not write ESC');
  const afterGrok = writes.length;
  await handleSlash('/tier grok4.6', t);
  assert.equal(writes.length, afterGrok, 'same /tier must not write /model again');
  await handleSlash('/tier auto', t);
  assert.ok(writes.some((w) => String(w).includes('/model openzoo/auto')));
  assert.ok(!writes.includes(ESC));

  writes.length = 0;
  await writeAgentPtyLine(t.id, '/goal do the job');
  assert.deepEqual([...writes], ['/goal do the job' + CR], 'at prompt: line+CR only, no ESC');
  assert.ok(t.goalSet, 'writeAgentPtyLine /goal persists goalSet');

  writes.length = 0;
  const port = Number(process.env.OZ_GROKUI_PORT);
  const posted = await fetch('http://127.0.0.1:' + port + '/threads/' + t.id + '/pty', {
    method: 'POST',
    body: '/goal from post' + CR,
  });
  assert.equal(posted.ok, true);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual([...writes], ['/goal from post' + CR], 'POST /pty at prompt: no ESC');

  writes.length = 0;
  const stop = await fetch('http://127.0.0.1:' + port + '/threads/' + t.id + '/pty', {
    method: 'POST',
    body: ESC,
  });
  assert.equal(stop.ok, true);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual([...writes], [ESC], '1-byte ESC body writes ESC only');

  // Busy then slash: Esc, wait until buf grows AND looks ready, then full /goal.
  writes.length = 0;
  const busy = newThread('slash-busy', null);
  const busySess = ensureAgentPty(busy);
  busySess.buf = Buffer.from('running tools…');
  assert.equal(ptyLooksReady(busySess), false);
  growOnEsc = () => {
    setTimeout(() => {
      busySess.buf = Buffer.concat([busySess.buf, Buffer.from('\n> ')]);
    }, 15);
  };
  const busyP = writeAgentPtyLine(busy.id, '/goal do the job');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(writes[0], ESC, 'busy slash writes ESC first');
  assert.equal(writes.length, 1, 'must not concatenate Esc and / in one burst');
  await busyP;
  assert.equal(writes[1], '/goal do the job' + CR);
  assert.ok(String(writes[1]).startsWith('/goal'), 'slash still present after Esc');
  assert.equal(writes.length, 2);
  assert.ok(busy.goalSet);
  growOnEsc = null;

  // Regular 'hi' writes immediately — do not wait for `>`.
  writes.length = 0;
  const hi = newThread('hi-now', null);
  const hiSess = ensureAgentPty(hi);
  hiSess.buf = Buffer.alloc(0);
  assert.equal(ptyLooksReady(hiSess), false);
  const t0 = Date.now();
  await writeAgentPtyLine(hi.id, 'hi');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 200, 'hi must not wait for > (ate the send when it did); took ' + elapsed + 'ms');
  assert.deepEqual([...writes], ['hi' + CR]);

  writes.length = 0;
  await writeAgentPtyLine(hi.id, 'there');
  assert.equal(writes[0], ESC, 'later regular text interrupts first');
  assert.equal(writes[1], 'there' + CR);

  const fresh = newThread('hi-fresh-tip', null);
  assert.equal(Boolean(fresh.goalSet), false, 'new chats show the /goal tip again');

  killAgentPty(t.id);
  const d = ensureAgentPty(t);
  assert.notEqual(d, a);
  assert.equal(spawns, 4);
  setAgentPtySpawnerForTest(null);
});

test('APP_HTML has no CR/LF/ESC string literals; served script node --checks', () => {
  const src = readFileSync(path.join(root, 'lib', 'grokui.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('const APP_HTML = `');
  const end = src.indexOf('`;\n\nconst server = http.createServer', start);
  assert.ok(start >= 0 && end > start);
  const literal = src.slice(start + 'const APP_HTML = '.length, end + 1);
  assert.doesNotMatch(literal, /"\\r"|'\\r'/);
  assert.doesNotMatch(literal, /"\\n"|'\\n'/);
  assert.doesNotMatch(literal, /\\x1b|\\u001b/);
  assert.ok(!/\r/.test(literal));
  const html = Function('SUBSCRIPTIONS_PAGE', 'return ' + literal)('https://example.test/subscriptions');
  assert.match(html, /id="goalTip"/);
  assert.match(html, /Pro tip: \/goal/);
  let close = html.lastIndexOf('</script>');
  let open = html.lastIndexOf('<script>', close);
  const script = html.slice(open + '<script>'.length, close);
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-agent-apphtml-'));
  try {
    const file = path.join(dir, 'apphtml.js');
    writeFileSync(file, script);
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
