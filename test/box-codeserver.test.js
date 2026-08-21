import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { buildClineFiles, clineConfigPaths } from '../box-cline-config.mjs';
import { injectMobileHtml, isMobileUA, mobileShellHtml, wantsMobileShell, VIEWPORT } from '../box-front.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = readFileSync(path.join(root, 'box.Dockerfile'), 'utf8');
const boot = readFileSync(path.join(root, 'box-boot.sh'), 'utf8');
const workflow = readFileSync(path.join(root, '.github', 'workflows', 'docker-box.yml'), 'utf8');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on('error', reject);
  });
}

test('box image is Debian bookworm + node 22 + code-server + Cline, never alpine', () => {
  assert.match(dockerfile, /FROM node:22-bookworm-slim/);
  assert.match(dockerfile, /code-server\.dev\/install\.sh/);
  assert.match(dockerfile, /saoudrizwan\.claude-dev/);
  assert.match(dockerfile, /EXPOSE 8080/);
  assert.match(dockerfile, /EXPOSE 8080 8402/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /8080\/health/);
  assert.doesNotMatch(dockerfile, /^FROM alpine/im);
  assert.doesNotMatch(dockerfile, /alpine:[0-9]/);
  assert.doesNotMatch(dockerfile, /ENV\s+ANTHROPIC_API_KEY=/);
  assert.match(dockerfile, /Never ENV ANTHROPIC_API_KEY/);
  assert.match(dockerfile, /ANTHROPIC_BASE_URL=https:\/\/x402-tokens\.fly\.dev\/v1/);
  assert.match(dockerfile, /OPENZOO_NO_TUNNEL=1/);
  assert.doesNotMatch(dockerfile, /OZ_GROKUI_PORT=4173/);
  assert.doesNotMatch(dockerfile, /EXPOSE[^\n]*4173/);
  assert.match(dockerfile, /box-mobile\.css/);
  assert.match(dockerfile, /openzoo\.box-mobile-1\.0\.0/);
});

test('box-boot puts code-server behind :8080 with password auth, not grokui', () => {
  assert.match(boot, /unset ANTHROPIC_API_KEY/);
  assert.match(boot, /OPENZOO_NO_TUNNEL=1/);
  assert.match(boot, /x402-tokens\.fly\.dev\/v1/);
  assert.match(boot, /OPENZOO_IDE_PASSWORD/);
  assert.match(boot, /OPENZOO_SUB_KEY/);
  assert.match(boot, /ANTHROPIC_AUTH_TOKEN/);
  assert.match(boot, /--auth password/);
  assert.match(boot, /auth: password/);
  assert.match(boot, /auth none is forbidden/);
  assert.match(boot, /code-server/);
  assert.match(boot, /box-front\.mjs/);
  assert.match(boot, /box-cline-config\.mjs/);
  assert.match(boot, /Do not launch grokui\.mjs/);
  assert.doesNotMatch(boot, /^\s+--auth none\b/m);
  assert.doesNotMatch(boot, /node "\$UI_ENTRY"/);
  assert.doesNotMatch(boot, /node .*grokui\.mjs/);
  assert.match(boot, /OPENZOO_WALLET_JSON/);
  assert.match(boot, /wallet\.json/);
  assert.match(boot, /box-mobile-inject\.mjs/);
});

test('docker-box still builds on grokui-v* tags and smokes :8080 /health', () => {
  assert.match(workflow, /tags: \['grokui-v\*', 'v\*'\]/);
  assert.match(workflow, /file: box.Dockerfile/);
  assert.match(workflow, /p 8080:8080/);
  assert.match(workflow, /8080\/health/);
  assert.match(workflow, /auth none/);
  assert.match(workflow, /ANTHROPIC_API_KEY/);
  assert.match(workflow, /saoudrizwan\.claude-dev/);
  assert.match(workflow, /command -v code-server/);
  assert.doesNotMatch(workflow, /4173:4173/);
  assert.doesNotMatch(workflow, /FAIL: grokui never served on :4173/);
  assert.match(workflow, /openzoo-box:latest/);
  assert.match(workflow, /\$G:latest/);
});

test('box-front answers GET /health 200 only after code-server /healthz', async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"alive"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('workbench');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upPort = upstream.address().port;
  const frontPort = await freePort();
  const syntax = spawnSync(process.execPath, ['--check', path.join(root, 'box-front.mjs')], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);

  const env = {
    ...process.env,
    OZ_BOX_FRONT_BIND: '127.0.0.1',
    OZ_BOX_FRONT_PORT: String(frontPort),
    OZ_CODE_SERVER_HOST: '127.0.0.1',
    OZ_CODE_SERVER_PORT: String(upPort),
    OZ_CODE_SERVER_READY_URL: `http://127.0.0.1:${upPort}/healthz`,
    OZ_MOBILE_DIR: root,
  };
  const frontProc = spawn(process.execPath, [path.join(root, 'box-front.mjs')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${frontPort}/health`);
        if (r.status === 200) {
          const j = await r.json();
          assert.equal(j.ok, true);
          assert.equal(j.service, 'code-server');
          ready = true;
          break;
        }
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(ready, true, 'front never answered /health 200');
    const proxied = await fetch(`http://127.0.0.1:${frontPort}/`);
    assert.equal(proxied.status, 200);
    assert.equal(await proxied.text(), 'workbench');
    const css = await fetch(`http://127.0.0.1:${frontPort}/__oz/mobile.css`);
    assert.equal(css.status, 200);
    assert.match(await css.text(), /part\.activitybar/);
    const phone = await fetch(`http://127.0.0.1:${frontPort}/`, {
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' },
    });
    assert.equal(phone.status, 200);
    const shell = await phone.text();
    assert.match(shell, /width=device-width/);
    assert.match(shell, /oz-workbench=1/);
  } finally {
    frontProc.kill('SIGTERM');
    upstream.close();
  }
});

test('Cline preconfig uses real storage keys and the OpenZoo gateway', () => {
  const files = buildClineFiles({
    token: 'oz_sub_token',
    gateway: 'https://x402-tokens.fly.dev/v1',
    discovered: { id: 'saoudrizwan.claude-dev', version: '4.1.11', configurationKeys: [] },
  });
  assert.equal(files.globalState.planModeApiProvider, 'anthropic');
  assert.equal(files.globalState.actModeApiProvider, 'anthropic');
  assert.equal(files.globalState.anthropicBaseUrl, 'https://x402-tokens.fly.dev/v1');
  assert.equal(files.secrets.apiKey, 'oz_sub_token');
  assert.equal(files.providers.lastUsedProvider, 'anthropic');
  assert.equal(files.providers.providers.anthropic.settings.baseUrl, 'https://x402-tokens.fly.dev/v1');
  assert.equal(files.providers.providers.anthropic.settings.apiKey, 'oz_sub_token');
  assert.equal(files.providers.providers.anthropic.settings.headers.Authorization, 'Bearer oz_sub_token');
  assert.doesNotMatch(JSON.stringify(files), /api\.anthropic\.com/);
  assert.equal(files.secrets.anthropicApiKey, undefined);

  const withKeys = buildClineFiles({
    token: 'oz_sub_token',
    gateway: 'https://x402-tokens.fly.dev/v1',
    discovered: {
      configurationKeys: ['claude-dev.apiProvider', 'claude-dev.anthropicBaseUrl', 'claude-dev.apiKey'],
    },
  });
  assert.equal(withKeys.userSettings['claude-dev.apiProvider'], 'anthropic');
  assert.equal(withKeys.userSettings['claude-dev.anthropicBaseUrl'], 'https://x402-tokens.fly.dev/v1');
  assert.equal(withKeys.userSettings['claude-dev.apiKey'], 'oz_sub_token');
  assert.equal(files.userSettings['workbench.activityBar.location'], 'hidden');
  assert.equal(files.userSettings['workbench.editor.showTabs'], 'none');
  assert.equal(files.userSettings['workbench.statusBar.visible'], false);
  assert.equal(files.userSettings['editor.fontSize'], 16);
  assert.equal(files.userSettings['window.menuBarVisibility'], 'hidden');
});

test('box-cline-config writes ~/.cline/data files from env', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-cline-'));
  try {
    const keys = path.join(dir, 'cline-config-keys.json');
    writeFileSync(keys, JSON.stringify({
      id: 'saoudrizwan.claude-dev',
      version: '4.1.11',
      configurationKeys: [],
    }));
    const r = spawnSync(process.execPath, [path.join(root, 'box-cline-config.mjs')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: dir,
        CLINE_CONFIG_KEYS: keys,
        OPENZOO_SUB_KEY: 'oz_from_env',
        ANTHROPIC_BASE_URL: 'https://x402-tokens.fly.dev/v1',
      },
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const paths = clineConfigPaths({ CLINE_DATA_DIR: path.join(dir, '.cline', 'data') }, dir);
    const globalState = JSON.parse(readFileSync(paths.globalState, 'utf8'));
    const secrets = JSON.parse(readFileSync(paths.secrets, 'utf8'));
    const providers = JSON.parse(readFileSync(paths.providers, 'utf8'));
    assert.equal(globalState.anthropicBaseUrl, 'https://x402-tokens.fly.dev/v1');
    assert.equal(secrets.apiKey, 'oz_from_env');
    assert.equal(providers.providers.anthropic.settings.baseUrl, 'https://x402-tokens.fly.dev/v1');
    const settings = JSON.parse(readFileSync(paths.userSettings, 'utf8'));
    assert.equal(settings['workbench.activityBar.location'], 'hidden');
    assert.equal(settings['editor.fontSize'], 16);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mobile CSS hides workbench chrome and keeps 44px tap targets', () => {
  const css = readFileSync(path.join(root, 'box-mobile.css'), 'utf8');
  const js = readFileSync(path.join(root, 'box-mobile.js'), 'utf8');
  const ext = readFileSync(path.join(root, 'box-mobile-ext', 'extension.js'), 'utf8');
  assert.match(css, /part\.activitybar/);
  assert.match(css, /part\.sidebar/);
  assert.match(css, /part\.statusbar/);
  assert.match(css, /part\.titlebar/);
  assert.match(css, /display:\s*none/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /100dvh/);
  assert.match(css, /keyboard-inset-height/);
  assert.match(js, /width=device-width/);
  assert.match(js, /viewport-fit=cover/);
  assert.match(js, /oz-chrome-toggle/);
  assert.match(js, /scrollIntoView/);
  assert.match(ext, /claude-dev-ActivityBar/);
  assert.match(ext, /activityBarLocation.hide/);
});

test('box-front injects device-width viewport and mobile shell for phones', () => {
  assert.equal(isMobileUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), true);
  assert.equal(isMobileUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), false);
  const req = { method: 'GET', url: '/', headers: { 'user-agent': 'iPhone' } };
  assert.equal(wantsMobileShell(req), true);
  assert.equal(wantsMobileShell({ method: 'GET', url: '/?oz-workbench=1', headers: { 'user-agent': 'iPhone' } }), false);
  const shell = mobileShellHtml();
  assert.match(shell, /width=device-width, initial-scale=1, viewport-fit=cover/);
  assert.match(shell, /<iframe/);
  assert.doesNotMatch(shell, /horizontal/);
  const injected = injectMobileHtml('<!doctype html><html><head></head><body>x</body></html>');
  assert.match(injected, new RegExp(VIEWPORT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(injected, /__oz\/mobile\.css/);
  assert.match(injected, /__oz\/mobile\.js/);
  assert.equal(injectMobileHtml(injected), injected);
});
