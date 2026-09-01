import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseTomlMcpServers, fromJsonMcpServers, loadHostMcpConfigs,
  mcpToOpenAiTool, toolOpenaiName, flattenMcpResult, chromeArgsFor, chromeStatus, CHROME_TOGGLE_HINT,
} from '../lib/mcpbridge.js';

test('parseTomlMcpServers reads grok-style stdio + http + headers', () => {
  const toml = `
[cli]
installer = "internal"

[mcp_servers.styxx]
command = "/opt/styxx-mcp"
args = []
enabled = true

[mcp_servers.brave]
command = "sh"
args = [
    "-c",
    "BRAVE_API_KEY=x exec npx -y @brave/brave-search-mcp-server",
]

[mcp_servers.openzoo]
command = "npx"
args = ["-y", "openzoo@latest", "mcp"]

[mcp_servers.proofnetwork]
url = "https://proofnetwork.example/mcp"
enabled = true

[mcp_servers.proofnetwork.headers]
Authorization = "Bearer test-token"

[mcp_servers.off]
command = "/bin/false"
enabled = false
`;
  const got = parseTomlMcpServers(toml);
  const by = Object.fromEntries(got.map((s) => [s.name, s]));
  assert.equal(by.styxx.command, '/opt/styxx-mcp');
  assert.deepEqual(by.brave.args.slice(0, 2), ['-c', 'BRAVE_API_KEY=x exec npx -y @brave/brave-search-mcp-server']);
  assert.equal(by.proofnetwork.url, 'https://proofnetwork.example/mcp');
  assert.equal(by.proofnetwork.headers.Authorization, 'Bearer test-token');
  assert.equal(by.openzoo.command, 'npx');
  assert.equal(by.off.enabled, false);
});

test('fromJsonMcpServers reads Claude mcp.json', () => {
  const got = fromJsonMcpServers({
    mcpServers: {
      styxx: { type: 'stdio', command: '/opt/styxx-mcp', args: [] },
      proofnetwork: { type: 'http', url: 'https://x.example/mcp', headers: { Authorization: 'Bearer z' } },
    },
  });
  assert.equal(got.length, 2);
  assert.equal(got.find((s) => s.name === 'proofnetwork').url, 'https://x.example/mcp');
});

test('loadHostMcpConfigs skips openzoo and always adds chrome-devtools', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-mcp-'));
  try {
    fs.mkdirSync(path.join(tmp, '.grok'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.grok', 'config.toml'), `
[mcp_servers.openzoo]
command = "npx"
args = ["-y", "openzoo@latest", "mcp"]
[mcp_servers.styxx]
command = "/opt/styxx-mcp"
`);
    fs.writeFileSync(path.join(tmp, '.claude', 'mcp.json'), JSON.stringify({
      mcpServers: { styxx: { command: '/opt/other-styxx' } },
    }));
    const got = loadHostMcpConfigs(tmp);
    const names = got.map((s) => s.name).sort();
    assert.ok(names.includes('styxx'));
    assert.ok(names.includes('chrome-devtools'));
    assert.ok(!names.includes('openzoo'));
    assert.equal(got.find((s) => s.name === 'styxx').command, '/opt/styxx-mcp');
    assert.equal(got.find((s) => s.name === 'chrome-devtools').command, 'npx');
    assert.ok(got.find((s) => s.name === 'chrome-devtools').args.includes('chrome-devtools-mcp@latest'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mcpToOpenAiTool prefixes server__tool for the zoo payload', () => {
  const t = mcpToOpenAiTool('chrome-devtools', {
    name: 'navigate_page',
    description: 'Go to a URL',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  });
  assert.equal(t.type, 'function');
  assert.equal(t.function.name, 'chrome-devtools__navigate_page');
  assert.match(t.function.description, /MCP chrome-devtools/);
  assert.equal(t.function.parameters.properties.url.type, 'string');
  assert.equal(toolOpenaiName('chrome-devtools', 'take_snapshot'), 'chrome-devtools__take_snapshot');
});

test('flattenMcpResult keeps text and flags isError', () => {
  assert.equal(flattenMcpResult({ content: [{ type: 'text', text: 'ok' }] }), 'ok');
  assert.match(flattenMcpResult({ isError: true, content: [{ type: 'text', text: 'nope' }] }), /^ERROR nope/);
});

test('chrome-devtools prefers the real Chrome (autoConnect), then real Brave, then a debug port, then its own profile', () => {
  const base = ['-y', 'chrome-devtools-mcp@latest'];
  const real = chromeArgsFor(base, { chromePort: 51234 });
  assert.equal(real.mode, 'real-chrome');
  assert.ok(real.args.includes('--autoConnect'));
  const brave = chromeArgsFor(base, { bravePort: 51235 });
  assert.equal(brave.mode, 'real-brave');
  assert.deepEqual(brave.args.slice(-2), ['--browserUrl', 'http://127.0.0.1:51235']);
  const port = chromeArgsFor(base, { openPorts: [9333] });
  assert.equal(port.mode, 'attached:9333');
  const own = chromeArgsFor(base, {});
  assert.equal(own.mode, 'own-profile');
  assert.ok(!own.args.includes('--autoConnect'));
  const explicit = chromeArgsFor([...base, '--browserUrl', 'http://x:1'], { chromePort: 1 });
  assert.equal(explicit.mode, 'explicit');
  assert.ok(!explicit.args.includes('--autoConnect'));
  assert.match(CHROME_TOGGLE_HINT, /chrome:\/\/inspect\/#remote-debugging/);
  assert.equal(typeof chromeStatus().mode, 'string');
});
