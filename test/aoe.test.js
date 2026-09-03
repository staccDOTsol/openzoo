import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  upsertTomlKey, stripTomlTable, mergeAoeConfig, aoeConfigPath, shQuote, tomlString, AGENT_NAME,
} from '../lib/aoe.js';

// A TOML file may only define a table once. The one way to break a user's
// whole AoE config is to append a second `[session.custom_agents]` header, so
// every path below is checked for exactly one header per table.
function headerCount(toml, table) {
  return toml.split('\n').filter((l) => l.trim() === `[${table}]`).length;
}

test('empty config gets a fresh header table', () => {
  const out = upsertTomlKey('', 'session.custom_agents', 'openzoo', '"openzoo claude"');
  assert.equal(out, '[session.custom_agents]\nopenzoo = "openzoo claude"\n');
});

test('existing header table receives the key and keeps its neighbours', () => {
  const src = `[session]
default_tool = "claude"

[session.custom_agents]
"lenovo-claude" = "ssh -t lenovo claude"

[sandbox]
image = "x"
`;
  const out = upsertTomlKey(src, 'session.custom_agents', 'openzoo', '"openzoo claude"');
  assert.equal(headerCount(out, 'session.custom_agents'), 1);
  assert.ok(out.includes('"lenovo-claude" = "ssh -t lenovo claude"'));
  assert.ok(out.includes('openzoo = "openzoo claude"'));
  assert.ok(out.includes('[sandbox]\nimage = "x"'));
  assert.ok(out.includes('default_tool = "claude"'));
});

test('an old value for our key is replaced, not duplicated', () => {
  const src = '[session.custom_agents]\nopenzoo = "/old/path claude"\nother = "x"\n';
  const out = upsertTomlKey(src, 'session.custom_agents', 'openzoo', '"openzoo claude"');
  assert.equal(out.split('\n').filter((l) => l.startsWith('openzoo =')).length, 1);
  assert.ok(out.includes('openzoo = "openzoo claude"'));
  assert.ok(out.includes('other = "x"'));
});

// The docs' own example spells custom_agents as an inline table under
// [session]. Appending a header there is the duplicate-table error.
test('inline-table form is edited in place, no header appended', () => {
  const src = `[session]
custom_agents = { "lenovo-claude" = "ssh -t lenovo claude", openzoo = "stale" }
agent_detect_as = {}
`;
  let out = upsertTomlKey(src, 'session.custom_agents', 'openzoo', '"openzoo claude"');
  out = upsertTomlKey(out, 'session.agent_detect_as', 'openzoo', '"claude"');
  assert.equal(headerCount(out, 'session.custom_agents'), 0);
  assert.equal(headerCount(out, 'session.agent_detect_as'), 0);
  assert.ok(out.includes('custom_agents = { openzoo = "openzoo claude", "lenovo-claude" = "ssh -t lenovo claude" }'), out);
  assert.ok(!out.includes('"stale"'));
  assert.ok(out.includes('agent_detect_as = { openzoo = "claude" }'), out);
});

test('a comma inside a quoted value does not split the inline table', () => {
  const src = '[session]\ncustom_agents = { a = "x, y" }\n';
  const out = upsertTomlKey(src, 'session.custom_agents', 'openzoo', '"z"');
  assert.ok(out.includes('custom_agents = { openzoo = "z", a = "x, y" }'), out);
});

test('the same key name in a different table is left alone', () => {
  const src = '[tools.openzoo]\ncommand = "x"\n\n[session.custom_agents]\nfoo = "bar"\n';
  const out = upsertTomlKey(src, 'session.agent_detect_as', 'openzoo', '"claude"');
  assert.ok(out.includes('[tools.openzoo]\ncommand = "x"'));
  assert.ok(out.includes('[session.custom_agents]\nfoo = "bar"'));
  assert.ok(out.endsWith('[session.agent_detect_as]\nopenzoo = "claude"\n'));
});

test('stripTomlTable removes only the named block', () => {
  const src = '[a]\nx = 1\n\n[tools.openzoo]\ncommand = "old"\nhotkey = "Alt+z"\n\n[b]\ny = 2\n';
  const out = stripTomlTable(src, 'tools.openzoo');
  assert.ok(!out.includes('tools.openzoo'));
  assert.ok(!out.includes('"old"'));
  assert.ok(out.includes('[a]\nx = 1'));
  assert.ok(out.includes('[b]\ny = 2'));
});

test('mergeAoeConfig is idempotent and declares the agent as a claude wrapper', () => {
  const once = mergeAoeConfig('', { launch: 'openzoo', logPath: '/h/.openzoo/proxy.log' });
  const twice = mergeAoeConfig(once.toml, { launch: 'openzoo', logPath: '/h/.openzoo/proxy.log' });
  assert.equal(twice.toml, once.toml);
  const t = once.toml;
  assert.equal(headerCount(t, 'session.custom_agents'), 1);
  assert.equal(headerCount(t, 'session.agent_detect_as'), 1);
  assert.equal(headerCount(t, 'tools.openzoo'), 1);
  assert.ok(t.includes(`${AGENT_NAME} = "openzoo claude"`));
  assert.ok(t.includes(`${AGENT_NAME} = "claude"`));
  assert.ok(t.includes('command = "openzoo balance; tail -n 40 -f /h/.openzoo/proxy.log"'));
  assert.ok(t.includes('hotkey = "Alt+z"'));
  // the built-in claude is NOT re-pointed unless asked
  assert.ok(!t.includes('agent_command_override'));
});

test('--override-claude also routes the built-in claude through the zoo', () => {
  const { toml } = mergeAoeConfig('[session.agent_command_override]\nopencode = "nono run -- opencode"\n', {
    launch: 'openzoo', overrideClaude: true, receipts: false,
  });
  assert.equal(headerCount(toml, 'session.agent_command_override'), 1);
  assert.ok(toml.includes('claude = "openzoo claude"'));
  assert.ok(toml.includes('opencode = "nono run -- opencode"'));
  assert.ok(!toml.includes('[tools.openzoo]'));
});

test('a launch path with spaces survives the shell AoE hands it to', () => {
  const launch = `${shQuote('/Users/me/Application Support/node')} ${shQuote('/tmp/openzoo/bin/openzoo.js')}`;
  assert.equal(launch, "'/Users/me/Application Support/node' /tmp/openzoo/bin/openzoo.js");
  const { toml } = mergeAoeConfig('', { launch, receipts: false });
  assert.ok(toml.includes(`openzoo = ${tomlString(`${launch} claude`)}`), toml);
});

test('aoeConfigPath follows aoe: XDG on linux, existing dir first on macOS', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aoe-home-'));
  const env = {};
  const legacy = path.join(home, '.agent-of-empires');
  const xdg = path.join(home, '.config', 'agent-of-empires');
  assert.equal(aoeConfigPath({ env, home, platform: 'linux' }), path.join(xdg, 'config.toml'));
  // fresh mac: legacy
  assert.equal(aoeConfigPath({ env, home, platform: 'darwin' }), path.join(legacy, 'config.toml'));
  // XDG_CONFIG_HOME set, nothing exists yet: XDG
  assert.equal(
    aoeConfigPath({ env: { XDG_CONFIG_HOME: path.join(home, '.config') }, home, platform: 'darwin' }),
    path.join(xdg, 'config.toml'),
  );
  // an existing legacy dir wins even with XDG_CONFIG_HOME set (aoe never moves it)
  fs.mkdirSync(legacy, { recursive: true });
  assert.equal(
    aoeConfigPath({ env: { XDG_CONFIG_HOME: path.join(home, '.config') }, home, platform: 'darwin' }),
    path.join(legacy, 'config.toml'),
  );
  // an existing XDG dir wins over everything
  fs.mkdirSync(xdg, { recursive: true });
  assert.equal(aoeConfigPath({ env, home, platform: 'darwin' }), path.join(xdg, 'config.toml'));
  // explicit override
  assert.equal(aoeConfigPath({ env: { OPENZOO_AOE_CONFIG: '/x/config.toml' }, home }), '/x/config.toml');
});
