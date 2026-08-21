import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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

test('ensureAgentPty reuses a live PTY; packed resolve; CLAUDE_SLASH has goal', async () => {
  const uiPort = 24800 + Math.floor(Math.random() * 2000);
  const home = mkdtempSync(path.join(tmpdir(), 'oz-agent-home-'));
  const packed = packedOccTree();
  process.env.HOME = home;
  process.env.OZ_GROKUI_PORT = String(uiPort);
  process.env.OZ_AGENT_PORTS = '0';
  const {
    newThread, ensureAgentPty, killAgentPty, setAgentPtySpawnerForTest,
    agentPtySpawnSpec, handleSlash, isGrokuiOwnedSlash, CLAUDE_SLASH_IN_AUTO,
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
      OPENZOO_CLAUDE_PATH_ONLY: '1',
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

  let spawns = 0;
  const writes = [];
  setAgentPtySpawnerForTest((_spec) => {
    spawns += 1;
    return {
      write: (s) => { writes.push(s); },
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

  await handleSlash('/tier grok4.6', t);
  assert.equal(t.tier, 'grok4.6');
  assert.ok(writes.some((w) => String(w).includes('/model x-ai/grok-4.6')));
  await handleSlash('/tier auto', t);
  assert.ok(writes.some((w) => String(w).includes('/model openzoo/auto')));

  killAgentPty(t.id);
  const d = ensureAgentPty(t);
  assert.notEqual(d, a);
  assert.equal(spawns, 2);
  setAgentPtySpawnerForTest(null);
});
