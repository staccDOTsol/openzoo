import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {
  findGrokBotAsar,
  loadAsar,
  readAsarFile,
  injectIndexHtml,
  MOBILE_CSS,
  handleCoordinatorFrame,
  handleCoordinatorRequest,
  lifecycleReady,
  HOST_STATUS,
  mintVisitor,
  parseOzWhoCookie,
  parseOzWhoValue,
  serializeOzWho,
  ozWhoSetCookie,
  VISITOR_SHORTNAMES,
  colorForShortname,
  DEFAULT_WEB_BIND,
  stripVisitorPrompt,
  formatVisitorPrompt,
  prefixVisitorRichText,
} from '../lib/grokbotweb.js';

test('asar is findable and index.html is the Grok Bot renderer', () => {
  const asar = findGrokBotAsar();
  assert.ok(asar, 'Grok Bot.app asar missing');
  const archive = loadAsar(asar);
  try {
    const html = readAsarFile(archive, 'dist/renderer/index.html').toString('utf8');
    assert.match(html, /<div id="root">/);
    assert.match(html, /index-DCpFUyZ2\.js/);
    const css = readAsarFile(archive, 'dist/renderer/assets/index-BrN-auUU.css');
    assert.ok(css && css.length > 100);
  } finally {
    try { fs.closeSync(archive.fd); } catch { /* */ }
  }
});

test('injectIndexHtml adds the shim and loosens connect-src', () => {
  const src = `<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; font-src 'self' data:; img-src 'self' data: file: https:; media-src 'self' sand-media:; connect-src 'self' ws: sand-media:;"
    />
    <script type="module" src="./assets/index.js"></script>
  </head><body><div id="root"></div></body></html>`;
  const out = injectIndexHtml(src);
  assert.match(out, /oz-shim\.js/);
  assert.match(out, /oz-mobile\.css/);
  assert.match(out, /connect-src 'self' ws: wss: blob:/);
  assert.ok(out.indexOf('oz-shim.js') < out.indexOf('type="module"'));
});

test('injectIndexHtml upgrades viewport for cover and phones', () => {
  const src = `<!doctype html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  </head><body></body></html>`;
  const out = injectIndexHtml(src);
  assert.match(out, /viewport-fit=cover/);
  assert.match(MOBILE_CSS, /max-width: 900px/);
  assert.match(MOBILE_CSS, /100dvh/);
  assert.match(MOBILE_CSS, /#oz-new-chat/);
  assert.match(MOBILE_CSS, /#oz-new-chat\[hidden\]/);
  assert.match(MOBILE_CSS, /min-width: 0 !important/);
  assert.match(MOBILE_CSS, /\[data-oz-spend-hide\]/);
  assert.doesNotMatch(MOBILE_CSS, /#oz-new-chat \{ display: none; \}/);
  assert.match(MOBILE_CSS, /overflow-y: auto/);
  assert.match(MOBILE_CSS, /sand-new-chat-bar/);
});

test('coordinator hello is answered with protocolVersion 1 + transport up', async () => {
  const frames = [];
  await handleCoordinatorFrame(
    { kind: 'lifecycle', phase: 'hello', protocolVersion: 1 },
    (f) => frames.push(f),
    { fetchImpl: async () => ({ ok: true, text: async () => '[]' }) },
  );
  assert.deepEqual(frames[0], lifecycleReady());
  assert.equal(frames[1].family, 'coordinator-transport-state');
  assert.equal(frames[1].payload.state, 'connected');
  assert.equal(frames[2].family, 'coordinator-transcript-source');
});

test('coordinator getHostStatus is the renderer-valid shape, not hijack {status:ready}', async () => {
  const value = await handleCoordinatorRequest('getHostStatus', {}, {
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ status: 'ready' }) }),
  });
  assert.deepEqual(value, HOST_STATUS);
  assert.equal(typeof value.isBusy, 'boolean');
  assert.equal(value.hostVersion, '0.30.0');
});

test('coordinator sendPrompt unwraps hijack {accepted:true}', async () => {
  const value = await handleCoordinatorRequest('sendPrompt', { prompt: 'hi' }, {
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ accepted: true }) }),
  });
  assert.equal(value.accepted, true);
});

test('coordinator uploadAttachment unwraps {path} so commit can finish', async () => {
  let sent;
  const value = await handleCoordinatorRequest(
    'uploadAttachment',
    { filename: 'paste.png', bytesBase64: 'iVBORw0KGgo=' },
    {
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(init.body);
        return {
          ok: true,
          text: async () => JSON.stringify({
            status: 'ok',
            value: { path: '/openzoo-uploads/paste.png' },
            path: '/openzoo-uploads/paste.png',
          }),
        };
      },
    },
  );
  assert.equal(sent.filename, 'paste.png');
  assert.equal(value.path, '/openzoo-uploads/paste.png');
});

test('coordinator listAgents passes a raw array through', async () => {
  const list = [{ id: 'a', name: 'arena' }];
  const value = await handleCoordinatorRequest('listAgents', {}, {
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify(list) }),
  });
  assert.deepEqual(value, list);
});

test('coordinator createAgent keeps agent.id for the renderer launcher', async () => {
  const agent = { id: 'n1', name: 'alice', description: '', path: '/local/n1' };
  const value = await handleCoordinatorRequest('createAgent', { name: 'alice' }, {
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify({ agent, id: agent.id, ...agent }),
    }),
  });
  assert.equal(value.agent.id, 'n1');
  assert.equal(value.agent.name, 'alice');
});

test('coordinator searchAgents always returns an array', async () => {
  const list = [{ id: 'a', name: 'arena' }, { id: 'b', name: 'gm' }];
  const value = await handleCoordinatorRequest('searchAgents', { query: 'gm' }, {
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify(list) }),
  });
  assert.ok(Array.isArray(value));
  assert.equal(value.length, 1);
  assert.equal(value[0].id, 'b');
});

test('createAgent sse is a full roster, not action:created', () => {
  const src = fs.readFileSync(new URL('../lib/cursorbackend.js', import.meta.url), 'utf8');
  assert.match(src, /function pushCreatedAgent/);
  assert.match(src, /kickstartAgent/);
  assert.match(src, /isIntroductionInFlight: false/);
  assert.doesNotMatch(src, /action: 'created'/);
});

test('coordinator request frame replies with value present (void-safe)', async () => {
  const frames = [];
  await handleCoordinatorFrame(
    { kind: 'request', requestId: 'r-1', method: 'clearTrays', args: {} },
    (f) => frames.push(f),
    { fetchImpl: async () => { throw new Error('offline'); } },
  );
  assert.equal(frames[0].kind, 'reply');
  assert.equal(frames[0].outcome.status, 'ok');
  assert.equal('value' in frames[0].outcome, true);
});

test('web server serves shim + injected renderer without the hijack', async () => {
  const { startGrokBotWeb } = await import('../lib/grokbotweb.js');
  const started = await startGrokBotWeb({ skipBackend: true, port: 0, bind: '127.0.0.1', log: () => {} });
  try {
    const port = started.server.address().port;
    const health = await fetch(`http://127.0.0.1:${port}/oz-health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.equal(typeof health.agents, 'number');
    const shim = await fetch(`http://127.0.0.1:${port}/oz-shim.js`).then((r) => r.text());
    assert.match(shim, /window\.desktop/);
    assert.match(shim, /coordinatorPort/);
    assert.match(shim, /__OZ_WHO_PALETTE__/);
    assert.match(shim, /oz-who-chip/);
    assert.match(shim, /oz-spend/);
    assert.match(shim, /__OZ_SPEND_CHIP__/);
    assert.match(shim, /ozCollapseSpend/);
    assert.match(shim, /color-mix/);
    assert.match(shim, /MutationObserver/);
    assert.match(shim, /ozOpenTopConversation/);
    assert.match(shim, /oz-narrow/);
    assert.match(shim, /ozEnsureNewChatFab/);
    assert.match(shim, /ozFindNewChat/);
    assert.match(shim, /ozBtnOnScreen/);
    assert.match(shim, /ozFireNewChat/);
    assert.match(shim, /ozIsPhone/);
    assert.match(shim, /metaKey: true/);
    assert.match(shim, /ozHideSpendLeftovers/);
    assert.match(shim, /spendOnlyText/);
    assert.match(shim, /ozVisibleSpendText/);
    assert.match(shim, /ozPreviousMessageCard/);
    assert.match(shim, /ozAttachSpendChip/);
    assert.match(shim, /sand-message-card/);
    assert.match(shim, /data-oz-spend-hide/);
    const css = await fetch(`http://127.0.0.1:${port}/oz-mobile.css`).then((r) => r.text());
    assert.match(css, /100dvh/);
    assert.match(css, /#oz-new-chat/);
    assert.match(css, /\[data-oz-spend-hide\]/);
    assert.doesNotMatch(shim, /oz-who-badge/);
    assert.doesNotMatch(shim, /background-color/);
    assert.doesNotMatch(shim, /setProperty\('color'/);
    assert.match(shim, /getSelectedTeam: async \(\) => \(\{ selectedTeamId: null, fallback: null \}\)/);
    assert.match(shim, /listAccounts: async \(\) => \(\{ accounts: \[ACCOUNT\] \}\)/);
    const whoRes = await fetch(`http://127.0.0.1:${port}/oz-who`);
    const setCookie = whoRes.headers.get('set-cookie');
    assert.match(setCookie, /oz_who=/);
    assert.doesNotMatch(setCookie, /httponly/i);
    const who1 = await whoRes.json();
    assert.ok(VISITOR_SHORTNAMES.includes(who1.shortname), who1.shortname);
    assert.match(who1.id, /^[a-f0-9]{8}$/);
    assert.match(who1.color, /^#[0-9a-f]{6}$/);
    const who2 = await fetch(`http://127.0.0.1:${port}/oz-who`, {
      headers: { cookie: setCookie.split(';')[0] },
    }).then((r) => r.json());
    assert.deepEqual(who2, who1);
    const html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
    assert.match(html, /oz-shim\.js/);
    assert.match(html, /id="root"/);
    const jsName = html.match(/src="\.\/assets\/(index-[^"]+\.js)"/)[1];
    const js = await fetch(`http://127.0.0.1:${port}/assets/${jsName}`);
    assert.equal(js.status, 200);
    const body = Buffer.from(await js.arrayBuffer());
    assert.ok(body.length > 1000, `renderer bundle too small: ${body.length}`);
  } finally {
    started.close();
  }
});

test('web bind defaults to all interfaces unless env overrides', () => {
  if (!process.env.OZ_GROKBOT_WEB_BIND && !process.env.OPENZOO_BIND) {
    assert.equal(DEFAULT_WEB_BIND, '0.0.0.0');
  }
});

test('mintVisitor assigns unique shortnames, colors, and ids', () => {
  const used = new Set();
  const names = new Set();
  const colors = new Set();
  const ids = new Set();
  for (let i = 0; i < 20; i += 1) {
    const v = mintVisitor(used);
    assert.ok(VISITOR_SHORTNAMES.includes(v.shortname), v.shortname);
    assert.doesNotMatch(v.shortname, /^user-\d+$/i);
    assert.match(v.id, /^[a-f0-9]{8}$/);
    assert.match(v.color, /^#[0-9a-f]{6}$/);
    assert.equal(v.color, colorForShortname(v.shortname));
    names.add(v.shortname);
    colors.add(v.color);
    ids.add(v.id);
  }
  assert.equal(names.size, 20);
  assert.equal(colors.size, 20);
  assert.equal(ids.size, 20);
});

test('oz_who cookie parse/serialize is stable', () => {
  const v = { id: 'a1b2c3d4', shortname: 'maya', color: '#e85d4c' };
  assert.equal(serializeOzWho(v), 'a1b2c3d4.maya.e85d4c');
  assert.deepEqual(parseOzWhoValue('a1b2c3d4.maya.e85d4c'), v);
  const header = `sid=x; ${ozWhoSetCookie(v).split(';')[0]}; other=1`;
  assert.deepEqual(parseOzWhoCookie(header), v);
  assert.equal(parseOzWhoCookie(''), null);
  assert.equal(parseOzWhoCookie('foo=bar'), null);
  assert.deepEqual(parseOzWhoCookie(ozWhoSetCookie(v)), v);
});

test('coordinator sendPrompt body includes visitor', async () => {
  let sent;
  const visitor = { id: 'abcd1234', shortname: 'maya', color: '#e85d4c' };
  const value = await handleCoordinatorRequest('sendPrompt', { prompt: 'hi' }, {
    visitor,
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body);
      return { ok: true, text: async () => JSON.stringify({ accepted: true }) };
    },
  });
  assert.equal(value.accepted, true);
  assert.equal(sent.prompt, 'hi');
  assert.deepEqual(sent.visitor, visitor);
});

test('visitor prompt prefix is for the canvas and strips before zoo', () => {
  assert.equal(formatVisitorPrompt('maya', 'hello'), 'maya: hello');
  assert.equal(formatVisitorPrompt('maya', 'maya: hello'), 'maya: hello');
  assert.equal(stripVisitorPrompt('maya: hello'), 'hello');
  assert.equal(stripVisitorPrompt('hello'), 'hello');
  assert.equal(stripVisitorPrompt('note: keep this'), 'note: keep this');
});

test('visitor richText gets the same shortname prefix the canvas actually renders', () => {
  const src = JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'how r u mate!' }] }],
  });
  const out = JSON.parse(prefixVisitorRichText(src, 'kit', 'kit: how r u mate!'));
  assert.equal(out.content[0].content[0].text, 'kit: how r u mate!');
  const again = prefixVisitorRichText(JSON.stringify(out), 'kit', 'kit: how r u mate!');
  assert.equal(JSON.parse(again).content[0].content[0].text, 'kit: how r u mate!');
  const empty = JSON.parse(prefixVisitorRichText('', 'maya', 'maya: hi?!'));
  assert.equal(empty.content[0].content[0].text, 'maya: hi?!');
});
