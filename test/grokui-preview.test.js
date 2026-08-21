import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const grokuiSrc = readFileSync(path.join(root, 'lib', 'grokui.mjs'), 'utf8');

test('html autopreview is wired in grokui.mjs', () => {
  assert.match(grokuiSrc, /function isPreviewableRel/);
  assert.match(grokuiSrc, /function ensureWorkspacePort/);
  assert.match(grokuiSrc, /function previewAck/);
  assert.match(grokuiSrc, /function htmlPreviewUrl/);
  assert.match(grokuiSrc, /function linkWorkspacePaths/);
  assert.match(grokuiSrc, /function parkPreviews/);
  assert.match(grokuiSrc, /html-preview/);
  assert.match(grokuiSrc, /height: 420px/);
  assert.match(grokuiSrc, /HTML_PREVIEW_RULE/);
  assert.match(grokuiSrc, /can't preview/);
  assert.match(grokuiSrc, /The harness will preview/);
  assert.match(grokuiSrc, /await previewAck\(originId, rel\)/);
  assert.match(grokuiSrc, /id="agentPreview"/);
  assert.match(grokuiSrc, /id="agentPreviewClose"/);
  assert.match(grokuiSrc, /function showAgentPreview/);
  assert.match(grokuiSrc, /function hideAgentPreview/);
  assert.match(grokuiSrc, /function pullAgentPreview/);
  assert.match(grokuiSrc, /function bouncePreviewFocus/);
  assert.match(grokuiSrc, /function bindPreviewFocusGuard/);
  assert.match(grokuiSrc, /function focusMessageComposer/);
  assert.match(grokuiSrc, /function htmlRelFromText/);
  assert.match(grokuiSrc, /function findPlayableHtmlRel/);
  assert.match(grokuiSrc, /body\.agent-mode #agentPreview\.show/);
  assert.match(grokuiSrc, /allow-scripts allow-same-origin allow-forms/);
  assert.doesNotMatch(grokuiSrc, /allow-pointer-lock/);
  assert.match(grokuiSrc, /tabindex="-1"/);
  assert.match(grokuiSrc, /hideAgentPreview\(true\)/);
  assert.match(grokuiSrc, /showAgentPreview\(ev\.url, ev\.rel, true\)/);
  assert.match(grokuiSrc, /\/threads\\\/\(\[\^\/\]\+\)\\\/preview/);
  assert.doesNotMatch(grokuiSrc, /Workspace server is still starting — try again in a second/);
  // A second `const chatHeader` in the same <script> is a SyntaxError and
  // kills the whole UI — including the preview iframe we just added.
  const script = grokuiSrc.split('const APP_HTML')[1] || '';
  assert.equal((script.match(/const chatHeader/g) || []).length, 1);
});

test('Agent preview chrome has an X and iframe cannot steal Message focus', () => {
  const src = grokuiSrc.replace(/\r\n/g, '\n');
  const start = src.indexOf('const APP_HTML = `');
  const end = src.indexOf('`;\n\nconst server = http.createServer', start);
  assert.ok(start >= 0 && end > start, 'APP_HTML template bounds');
  const literal = src.slice(start + 'const APP_HTML = '.length, end + 1);
  assert.doesNotMatch(literal, /"\\r"|'\\r'/);
  const html = Function('SUBSCRIPTIONS_PAGE', 'return ' + literal)('https://example.test/subscriptions');
  assert.match(html, /id="agentPreviewClose"/);
  assert.match(html, /aria-label="Close preview"/);
  assert.match(html, /id="agentPreviewFrame"[^>]*tabindex="-1"/);
  assert.match(html, /id="agentPreviewFrame"[^>]*sandbox="allow-scripts allow-same-origin allow-forms"/);
  assert.doesNotMatch(html, /allow-pointer-lock/);
  assert.match(html, /function bouncePreviewFocus/);
  assert.match(html, /function focusMessageComposer/);
  assert.match(html, /hideAgentPreview\(true\)/);
  assert.match(html, /html-preview-close/);
  let close = html.lastIndexOf('</script>');
  let open = html.lastIndexOf('<script>', close);
  const script = html.slice(open + '<script>'.length, close);
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-preview-focus-'));
  try {
    const file = path.join(dir, 'apphtml.js');
    writeFileSync(file, script);
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WRITE of html acks a live localhost URL that serves the file', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-preview-'));
  const script = path.join(dir, 'run.mjs');
  const uiPort = 18000 + Math.floor(Math.random() * 2000);
  writeFileSync(script, `
    process.env.OZ_WORKSPACE_DIR = ${JSON.stringify(dir)};
    process.env.OZ_GROKUI_PORT = ${JSON.stringify(String(uiPort))};
    process.env.OZ_AGENT_PORTS = '0';
    const { tryDirective, ensureWorkspacePort } = await import(${JSON.stringify(path.join(root, 'lib/grokui.mjs'))});
    const uiPort = ${uiPort};
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch('http://127.0.0.1:' + uiPort + '/threads');
        if (r.ok) { ready = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!ready) { console.error(JSON.stringify({ error: 'grokui did not start' })); process.exit(1); }
    const t = await (await fetch('http://127.0.0.1:' + uiPort + '/threads', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'PreviewBot' }),
    })).json();
    const ack = await tryDirective(
      'WRITE: fries-vs-birds.html | <!doctype html><html><body>fries fly</body></html>',
      t.id,
    );
    const wsPort = await ensureWorkspacePort();
    const url = 'http://127.0.0.1:' + wsPort + '/' + t.id + '/fries-vs-birds.html';
    const html = await (await fetch(url)).text();
    const page = await (await fetch('http://127.0.0.1:' + uiPort + '/')).text();
    const summary = await (await fetch('http://127.0.0.1:' + uiPort + '/threads')).json();
    const txt = await tryDirective('WRITE: notes.txt | just text', t.id);
    const edited = await tryDirective('EDIT: fries-vs-birds.html |fries fly|||fries vs birds', t.id);
    const html2 = await (await fetch(url)).text();
    console.log(JSON.stringify({
      ack, edited, txt, html, html2, wsPort,
      workspacePort: (summary.find((x) => x.id === t.id) || {}).workspacePort,
      hasPreviewCss: /html-preview/.test(page),
      hasClientUrl: /clientWorkspaceUrl/.test(page),
      hasPreviewFn: /htmlPreviewUrl/.test(page),
    }));
    process.exit(0);
  `);
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: root, env: { ...process.env, OZ_AGENT_PORTS: '0' } });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.stderr.on('data', (d) => { buf += d; });
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('preview child timed out: ' + buf)); }, 15000);
    child.on('exit', (code) => {
      clearTimeout(t);
      if (code !== 0) reject(new Error('preview child exited ' + code + ': ' + buf));
      else resolve(buf);
    });
  });
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, 'child printed a JSON result');
  const r = JSON.parse(line);
  assert.match(r.ack, /Preview: http:\/\/localhost:\d+\/[0-9a-f-]+\/fries-vs-birds\.html/);
  assert.match(r.html, /fries fly/);
  assert.equal(r.hasPreviewCss, true);
  assert.equal(r.hasClientUrl, true);
  assert.equal(r.hasPreviewFn, true);
  assert.equal(r.workspacePort, r.wsPort);
  assert.doesNotMatch(r.txt, /Preview:/);
  assert.match(r.edited, /Preview: http:\/\/localhost:\d+\//);
  assert.match(r.html2, /fries vs birds/);
});

test('htmlRelFromText and findPlayableHtmlRel see OCC writes and existing index.html', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-agent-html-'));
  mkdirSync(path.join(dir, 'tetris-game'), { recursive: true });
  writeFileSync(path.join(dir, 'tetris-game', 'index.html'), '<!doctype html><title>t</title>');
  const script = path.join(dir, 'run.mjs');
  const uiPort = 19100 + Math.floor(Math.random() * 500);
  writeFileSync(script, `
    process.env.OZ_WORKSPACE_DIR = ${JSON.stringify(dir)};
    process.env.OZ_GROKUI_PORT = ${JSON.stringify(String(uiPort))};
    process.env.OZ_AGENT_PORTS = '0';
    const path = await import('node:path');
    const { writeFileSync } = await import('node:fs');
    const { htmlRelFromText, findPlayableHtmlRel, newThread } = await import(${JSON.stringify(path.join(root, 'lib/grokui.mjs'))});
    const dir = ${JSON.stringify(dir)};
    const t = newThread('AgentPreview');
    t.dir = dir;
    const nested = findPlayableHtmlRel(t.id);
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>root</title>');
    const rootIdx = findPlayableHtmlRel(t.id);
    const fromWrite = htmlRelFromText('File written: ' + path.join(dir, 'tetris-game', 'index.html'), t.id);
    const missing = htmlRelFromText('Wrote missing.html (120 bytes) to ' + dir, t.id);
    writeFileSync(path.join(dir, 'play.html'), '<!doctype html>');
    const updated = htmlRelFromText('File updated: ' + path.join(dir, 'play.html'), t.id);
    const ansi = htmlRelFromText('\\x1b[32mFile written: ' + path.join(dir, 'index.html') + '\\x1b[0m', t.id);
    console.log(JSON.stringify({ nested, rootIdx, fromWrite, missing, updated, ansi }));
    process.exit(0);
  `);
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: root, env: { ...process.env, OZ_AGENT_PORTS: '0' } });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.stderr.on('data', (d) => { buf += d; });
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('preview rel timed out: ' + buf)); }, 15000);
    child.on('exit', (code) => {
      clearTimeout(t);
      if (code !== 0) reject(new Error('preview rel exited ' + code + ': ' + buf));
      else resolve(buf);
    });
  });
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, 'child printed a JSON result');
  const r = JSON.parse(line);
  assert.equal(r.nested, 'tetris-game/index.html');
  assert.equal(r.rootIdx, 'index.html');
  assert.equal(r.fromWrite, 'tetris-game/index.html');
  assert.equal(r.missing, '');
  assert.equal(r.updated, 'play.html');
  assert.equal(r.ansi, 'index.html');
});

test('Agent mode loads zoo.openzoo.fun/ide/session in #agentPreview; 401 locks / Pay', () => {
  assert.match(grokuiSrc, /from '\.\/hosted-ide\.js'/);
  assert.match(grokuiSrc, /openStoredIdeSession/);
  assert.match(grokuiSrc, /req\.method === 'POST' && req\.url === '\/ide\/session'/);
  assert.match(grokuiSrc, /function openAgentIde/);
  assert.match(grokuiSrc, /function lockAgentIde/);
  assert.match(grokuiSrc, /function showAgentIde/);
  assert.match(grokuiSrc, /function shouldKeepIdeFocus/);
  assert.match(grokuiSrc, /function clearAgentIde/);
  assert.match(grokuiSrc, /body\.agent-mode\.agent-ide #agentPreview\.show/);
  assert.match(grokuiSrc, /body\.agent-mode\.agent-ide #agentTerm \{ display: none; \}/);
  assert.match(grokuiSrc, /body\.agent-mode\.agent-locked #agentTerm \{ display: none; \}/);
  assert.match(grokuiSrc, /status === 401/);
  assert.match(grokuiSrc, /lockAgentIde\(\)/);
  assert.match(grokuiSrc, /openWallet\(\)/);
  assert.match(grokuiSrc, /hideAgentPreview\(true\)/);
  assert.match(grokuiSrc, /shouldKeepIdeFocus/);
  assert.match(grokuiSrc, /agentIdeClicked/);
  const ideRoute = grokuiSrc.slice(grokuiSrc.indexOf("req.url === '/ide/session'"), grokuiSrc.indexOf("req.url === '/ide/session'") + 800);
  assert.match(ideRoute, /openStoredIdeSession/);
  assert.doesNotMatch(ideRoute, /ANTHROPIC_API_KEY:/);
  assert.doesNotMatch(grokuiSrc, /pkill/);
  const src = grokuiSrc.replace(/\r\n/g, '\n');
  const start = src.indexOf('const APP_HTML = `');
  const end = src.indexOf('`;\n\nconst server = http.createServer', start);
  const literal = src.slice(start + 'const APP_HTML = '.length, end + 1);
  const html = Function('SUBSCRIPTIONS_PAGE', 'return ' + literal)('https://example.test/subscriptions');
  assert.match(html, /function openAgentIde/);
  assert.match(html, /API \+ '\/ide\/session'/);
  assert.match(html, /method: 'POST'/);
  assert.match(html, /function lockAgentIde/);
  assert.match(html, /id="agentPreviewClose"/);
  assert.match(html, /hideAgentPreview\(true\)/);
  assert.match(html, /shouldKeepIdeFocus/);
  assert.match(html, /data-kind', 'ide'/);
});

test('narrow viewport Agent IDE is full-bleed; Close X stays; desktop iframe unchanged', () => {
  assert.match(grokuiSrc, /viewport-fit=cover/);
  assert.match(grokuiSrc, /@media \(max-width: 720px\), \(pointer: coarse\) and \(max-width: 920px\)/);
  assert.match(grokuiSrc, /body\.agent-mode\.agent-ide #agentPreview\.show \{[\s\S]*?position: fixed; inset: 0/);
  assert.match(grokuiSrc, /body\.agent-mode\.agent-ide #agentPreview iframe\.html-preview \{[\s\S]*?position: absolute; inset: 0/);
  assert.match(grokuiSrc, /transform: none; zoom: 1/);
  assert.match(grokuiSrc, /body\.agent-mode\.agent-ide #agentPreview \.html-preview-open \{ display: none; \}/);
  assert.match(grokuiSrc, /body\.agent-mode\.agent-ide #agentPreviewClose/);
  assert.match(grokuiSrc, /id="agentPreviewClose"/);
  assert.match(grokuiSrc, /hideAgentPreview\(true\)/);
  // Wide desktop keeps the in-flow iframe (not fixed overlay).
  assert.match(grokuiSrc, /body\.agent-mode\.agent-ide #agentPreview\.show \{ flex: 1 1 auto; min-height: 0; max-height: none; \}/);
  const src = grokuiSrc.replace(/\r\n/g, '\n');
  const start = src.indexOf('const APP_HTML = `');
  const end = src.indexOf('`;\n\nconst server = http.createServer', start);
  const literal = src.slice(start + 'const APP_HTML = '.length, end + 1);
  const html = Function('SUBSCRIPTIONS_PAGE', 'return ' + literal)('https://example.test/subscriptions');
  assert.match(html, /id="agentPreviewClose"/);
  assert.match(html, /aria-label="Close preview"/);
  assert.match(html, /position: fixed; inset: 0/);
  assert.match(html, /100dvh/);
  assert.match(html, /viewport-fit=cover/);
});

test('grokui POST /ide/session is 401 without a subscription key', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-ide-401-'));
  const script = path.join(dir, 'run.mjs');
  const uiPort = 19200 + Math.floor(Math.random() * 500);
  writeFileSync(script, `
    import http from 'node:http';
    process.env.OZ_WORKSPACE_DIR = ${JSON.stringify(dir)};
    process.env.OZ_GROKUI_PORT = ${JSON.stringify(String(uiPort))};
    process.env.OZ_AGENT_PORTS = '0';
    delete process.env.OPENZOO_SUBSCRIPTION_KEY;
    process.env.OPENZOO_SUBSCRIPTION_PATH = ${JSON.stringify(path.join(dir, 'no-such-sub.json'))};
    await import(${JSON.stringify(path.join(root, 'lib/grokui.mjs'))});
    const uiPort = ${uiPort};
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch('http://127.0.0.1:' + uiPort + '/threads');
        if (r.ok) { ready = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!ready) { console.error(JSON.stringify({ error: 'grokui did not start' })); process.exit(1); }
    const miss = await fetch('http://127.0.0.1:' + uiPort + '/ide/session', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const body = await miss.json();
    const door = await new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        if (req.headers.authorization !== 'Bearer oz_test_ide_keyxx') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ url: 'https://box.example/ide', password: 'pw', id: 'ide-x' }));
      });
      s.listen(0, '127.0.0.1', () => resolve({ s, port: s.address().port }));
    });
    process.env.OPENZOO_SUBSCRIPTION_KEY = 'oz_test_ide_keyxx';
    process.env.OPENZOO_IDE_ORIGIN = 'http://127.0.0.1:' + door.port;
    const ok = await fetch('http://127.0.0.1:' + uiPort + '/ide/session', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const okBody = await ok.json();
    await new Promise((r) => door.s.close(r));
    console.log(JSON.stringify({ status: miss.status, body, okStatus: ok.status, okBody }));
    process.exit(0);
  `);
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: root, env: { ...process.env, OZ_AGENT_PORTS: '0' } });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.stderr.on('data', (d) => { buf += d; });
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ide 401 child timed out: ' + buf)); }, 15000);
    child.on('exit', (code) => {
      clearTimeout(t);
      if (code !== 0) reject(new Error('ide 401 child exited ' + code + ': ' + buf));
      else resolve(buf);
    });
  });
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, 'child printed a JSON result');
  const r = JSON.parse(line);
  assert.equal(r.status, 401);
  assert.equal(r.body.ok, false);
  assert.equal(JSON.stringify(r.body).includes('sk-'), false);
  assert.equal(r.okStatus, 200);
  assert.equal(r.okBody.ok, true);
  assert.equal(r.okBody.url, 'https://box.example/ide?password=pw');
  assert.equal(r.okBody.id, 'ide-x');
  assert.equal(Object.prototype.hasOwnProperty.call(r.okBody, 'password'), false);
  assert.equal(JSON.stringify(r.okBody).includes('oz_test'), false);
});

