import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mergeCodexConfig, providerBlock, chatGptCandidates, resolveChatGptApp, findDownloadedDeb,
  codexConfigPath, PROVIDER_ID, API_KEY_ENV,
} from '../lib/chatgpt.js';

const opts = { model: 'claude-opus-5', port: 8402, wireApi: 'responses' };

test('an empty config.toml gets our two top-level keys and the provider table', () => {
  const out = mergeCodexConfig('', opts);
  assert.match(out, /^# written by `npx openzoo chatgpt`/);
  assert.match(out, /\nmodel = "claude-opus-5"\nmodel_provider = "openzoo"\n/);
  assert.match(out, /\[model_providers\.openzoo\]\nname = "openzoo"\nbase_url = "http:\/\/localhost:8402\/v1"\nwire_api = "responses"\nenv_key = "OPENZOO_API_KEY"\nrequires_openai_auth = false\n$/);
});

test('every other table survives; our stale table and old top-level keys are replaced', () => {
  const existing = [
    'model = "gpt-5.2"',
    'model_provider = "openai"',
    'approval_policy = "never"',
    '',
    '[model_providers.openzoo]',
    'name = "openzoo"',
    'base_url = "http://localhost:9999/v1"   # stale',
    '',
    '[model_providers.ollama]',
    'name = "Ollama"',
    'base_url = "http://localhost:11434/v1"',
    '',
    '[mcp_servers.foo]',
    'command = "foo"',
    '',
  ].join('\n');
  const out = mergeCodexConfig(existing, opts);
  assert.ok(!out.includes('9999'), 'stale openzoo table must be gone');
  assert.ok(!out.includes('"gpt-5.2"'), 'old top-level model must be gone');
  assert.ok(!out.includes('model_provider = "openai"'));
  assert.ok(out.includes('approval_policy = "never"'), 'unrelated top-level key kept');
  assert.ok(out.includes('[model_providers.ollama]\nname = "Ollama"\nbase_url = "http://localhost:11434/v1"'), 'other provider kept verbatim');
  assert.ok(out.includes('[mcp_servers.foo]\ncommand = "foo"'), 'unrelated table kept');
  // top-level keys precede the first table — TOML requires it
  assert.ok(out.indexOf('model_provider = "openzoo"') < out.indexOf('['));
  assert.equal((out.match(/\[model_providers\.openzoo\]/g) || []).length, 1);
});

test('running the merge twice is a no-op', () => {
  const once = mergeCodexConfig('[foo]\nbar = 1\n', opts);
  assert.equal(mergeCodexConfig(once, opts), once);
});

test('--bearer writes a static token instead of an env key; --wire chat is honoured', () => {
  const b = providerBlock({ port: 8402, wireApi: 'chat', bearer: true });
  assert.match(b, /wire_api = "chat"/);
  assert.match(b, /experimental_bearer_token = "sk-openzoo"/);
  assert.ok(!b.includes('env_key'));
});

test('app resolution: explicit env wins, then the .deb layout, then the unpack dir, then PATH', () => {
  const home = '/home/u';
  const env = { OPENZOO_CHATGPT_BIN: '/x/ChatGPT', PATH: '/usr/local/bin:/usr/bin' };
  const c = chatGptCandidates({ env, home, platform: 'linux' });
  assert.equal(c[0], '/x/ChatGPT');
  assert.equal(c[1], '/usr/lib/chatgpt/ChatGPT');
  assert.ok(c.includes(path.join(home, '.openzoo', 'apps', 'chatgpt', 'usr', 'lib', 'chatgpt', 'ChatGPT')));
  assert.ok(c.includes(path.join(home, 'apps', 'chatgpt', 'usr', 'lib', 'chatgpt', 'ChatGPT')));
  assert.equal(c[c.length - 1], '/usr/bin/chatgpt');
  const found = resolveChatGptApp({ env: { PATH: '/usr/bin' }, home, platform: 'linux', exists: (p) => p === '/usr/bin/chatgpt' });
  assert.equal(found, '/usr/bin/chatgpt');
  assert.equal(resolveChatGptApp({ env: {}, home, platform: 'linux', exists: () => false }), null);
  const mac = chatGptCandidates({ env: {}, home, platform: 'darwin' });
  assert.equal(mac[0], '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT');
});

test('the newest chatgpt*.deb in ~/Downloads is picked', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-home-'));
  const dl = path.join(home, 'Downloads');
  fs.mkdirSync(dl);
  fs.writeFileSync(path.join(dl, 'chatgpt_amd64.deb'), 'old');
  fs.writeFileSync(path.join(dl, 'other.deb'), 'x');
  const newer = path.join(dl, 'chatgpt_amd64 (1).deb');
  fs.writeFileSync(newer, 'new');
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(newer, t, t);
  assert.equal(findDownloadedDeb(home), newer);
  assert.equal(findDownloadedDeb(path.join(home, 'nope')), null);
});

test('config path honours CODEX_HOME', () => {
  assert.equal(codexConfigPath({ CODEX_HOME: '/c' }, '/h'), path.join('/c', 'config.toml'));
  assert.equal(codexConfigPath({}, '/h'), path.join('/h', '.codex', 'config.toml'));
  assert.equal(PROVIDER_ID, 'openzoo');
  assert.equal(API_KEY_ENV, 'OPENZOO_API_KEY');
});

const { setupChatGpt, launchChatGpt } = await import('../lib/chatgpt.js');
const { installerAsset, installChatGpt, downloadInstaller, windowsChatGptApp } = await import('../lib/chatgpt-install.js');
const temporaryHome = (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-chatgpt-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
};

for (const platform of ['darwin', 'win32', 'linux']) {
  for (const arch of ['x64', 'arm64']) {
    test(`current official installer selected for ${platform}/${arch}`, () => {
      const asset = installerAsset(platform, arch);
      assert.equal(new URL(asset.url).hostname, 'persistent.oaistatic.com');
      assert.match(asset.url, platform === 'linux' ? /linux\/deb\/latest\/chatgpt_(amd64|arm64)\.deb$/ : platform === 'win32' ? new RegExp(`ChatGPT-${arch}\\.msix$`) : arch === 'x64' ? /ChatGPT-latest-x64\.dmg$/ : /ChatGPT\.dmg$/);
    });
  }
  test(`${platform}: configure, install if missing, start proxy, then launch`, async (t) => {
    const home = temporaryHome(t), calls = [];
    await setupChatGpt([], { home, platform, env: {}, overlay: async () => {}, resolve: () => null,
      findWindows: async () => null,
      install: async () => { calls.push('install'); return '/test/app'; },
      proxy: async () => { calls.push('proxy'); return { started: true }; },
      launch: async (app, args, { env }) => {
        calls.push('launch');
        assert.equal(app, '/test/app');
        assert.equal(env.CODEX_HOME, path.join(home, '.openzoo', 'chatgpt'));
        assert.match(fs.readFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'utf8'), /model_provider = "openzoo"/);
      },
    });
    assert.deepEqual(calls, ['install', 'proxy', 'launch']);
  });
}

test('existing app skips download; --config controls launched CODEX_HOME; backup survives reruns', async (t) => {
  const home = temporaryHome(t), file = path.join(home, 'config.toml');
  fs.writeFileSync(file, 'model = "old"\n[other]\nvalue = true\n');
  const deps = { home, platform: 'linux', env: {}, resolve: () => '/installed/app',
    install: async () => assert.fail('must not install'),
    launch: async (_app, args, { env }) => {
      assert.equal(env.CODEX_HOME, home);
      assert.deepEqual(args, ['--ozone-platform=wayland']);
    } };
  const args = ['--config', file, '--no-proxy', '--no-pill', '--', '--ozone-platform=wayland'];
  await setupChatGpt(args, deps);
  await setupChatGpt(args, deps);
  assert.equal(fs.readFileSync(`${file}.openzoo-backup`, 'utf8'), 'model = "old"\n[other]\nvalue = true\n');
});

test('--no-launch only writes config, --print has no filesystem or process side effects', async (t) => {
  const home = temporaryHome(t);
  const fail = () => assert.fail('unexpected side effect');
  const deps = { home, env: {}, resolve: fail, install: fail, proxy: fail, launch: fail };
  await setupChatGpt(['--print'], deps);
  assert.deepEqual(fs.readdirSync(home), []);
  await setupChatGpt(['--no-launch'], deps);
  assert.ok(fs.existsSync(path.join(home, '.openzoo', 'chatgpt', 'config.toml')));
});

test('installation failure prevents proxy startup and launch', async (t) => {
  await assert.rejects(setupChatGpt([], { home: temporaryHome(t), env: {}, platform: 'linux',
    resolve: () => null, install: async () => { throw new Error('download failed'); },
    proxy: () => assert.fail('proxy started'), launch: () => assert.fail('app launched'),
  }), /download failed/);
});

test('macOS launches a bundle through LaunchServices with the provider environment', async () => {
  let seen;
  const env = { CODEX_HOME: '/a space/config', CODEX_ELECTRON_USER_DATA_PATH: '/a space/desktop', OPENZOO_API_KEY: 'sk-openzoo' };
  await launchChatGpt('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', ['--example'], {
    env, platform: 'darwin', run: async (...args) => { seen = args; },
  });
  assert.equal(seen[0], 'open');
  assert.ok(seen[1].includes('CODEX_HOME=/a space/config'));
  assert.ok(seen[1].includes('/Applications/ChatGPT.app'));
  assert.ok(seen[1].includes('--user-data-dir=/a space/desktop'));
});

test('Windows manifest resolution preserves paths with spaces', async () => {
  const result = await windowsChatGptApp(async (cmd, args) => {
    assert.equal(cmd, 'powershell.exe');
    assert.match(args.at(-1), /Get-AppxPackageManifest/);
    return 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\ChatGPT.exe\r\n';
  });
  assert.equal(result, 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\ChatGPT.exe');
  const candidates = chatGptCandidates({ platform: 'win32', home: 'C:\\Users\\A', env: { PATH: 'C:\\one;C:\\two' } });
  assert.ok(candidates.includes('C:\\two\\chatgpt.exe'));
});

test('Windows installs MSIX and resolves package afterward without shell interpolation', async (t) => {
  let downloaded, invoked = false;
  const result = await installChatGpt({ platform: 'win32', arch: 'arm64', home: temporaryHome(t),
    log: () => {}, download: async (_url, file) => { downloaded = file; fs.writeFileSync(file, 'fixture'); },
    run: async (command, args, options) => {
      invoked = true;
      assert.equal(command, 'powershell.exe');
      assert.match(args.at(-1), /Add-AppxPackage -Path \$env:OPENZOO_CHATGPT_INSTALLER/);
      assert.equal(options.env.OPENZOO_CHATGPT_INSTALLER, downloaded);
    }, findWindows: async () => 'C:\\ChatGPT.exe',
  });
  assert.equal(result, 'C:\\ChatGPT.exe');
  assert.ok(invoked);
  assert.ok(!fs.existsSync(downloaded));
});

test('macOS installation stages the app in user Applications and detaches the image', async (t) => {
  const home = temporaryHome(t), commands = [];
  const app = await installChatGpt({ platform: 'darwin', arch: 'arm64', home, log: () => {},
    download: async (_url, file) => fs.writeFileSync(file, 'fixture'),
    run: async (cmd, args) => {
      commands.push(cmd);
      if (cmd === 'hdiutil' && args[0] === 'attach') {
        const resources = path.join(args[4], 'ChatGPT.app', 'Contents', 'Resources');
        fs.mkdirSync(resources, { recursive: true });
        fs.writeFileSync(path.join(resources, 'codex'), 'fixture');
      }
      if (cmd === 'ditto') fs.cpSync(args[0], args[1], { recursive: true });
    },
  });
  assert.equal(app, path.join(home, 'Applications/ChatGPT.app/Contents/MacOS/ChatGPT'));
  assert.deepEqual(commands, ['hdiutil', 'codesign', 'ditto', 'hdiutil']);
});

test('macOS verification failure still detaches and never copies the app', async (t) => {
  const commands = [];
  await assert.rejects(installChatGpt({ platform: 'darwin', arch: 'x64', home: temporaryHome(t), log: () => {},
    download: async () => {}, run: async (cmd) => {
      commands.push(cmd);
      if (cmd === 'codesign') throw new Error('invalid signature');
    },
  }), /invalid signature/);
  assert.deepEqual(commands, ['hdiutil', 'codesign', 'hdiutil']);
});

test('Linux downloads and unpacks the native package without sudo', async (t) => {
  const home = temporaryHome(t);
  const app = await installChatGpt({ platform: 'linux', arch: 'arm64', home, log: () => {},
    download: async (url) => assert.match(url, /chatgpt_arm64.deb$/),
    unpack: (file, dest) => { assert.match(file, /chatgpt_arm64.deb$/); assert.equal(dest, path.join(home, '.openzoo/apps/chatgpt')); return '/unpacked/app'; },
  });
  assert.equal(app, '/unpacked/app');
});

test('download rejects HTTP errors and HTML, removes partial files', async (t) => {
  const file = path.join(temporaryHome(t), 'installer');
  await assert.rejects(downloadInstaller('https://test.invalid', file, async () => new Response('error', { status: 503 })), /503/);
  await assert.rejects(downloadInstaller('https://test.invalid', file, async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })), /HTML/);
  await downloadInstaller('https://test.invalid', file, async () => new Response('binary fixture'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'binary fixture');
  assert.ok(!fs.existsSync(`${file}.part`));
});

test('unsupported platforms and architectures fail explicitly', () => {
  assert.throws(() => installerAsset('freebsd', 'x64'), /not available/);
  assert.throws(() => installerAsset('linux', 'ia32'), /no installer/);
});

test('missing flag arguments fail before changing config', async (t) => {
  const home = temporaryHome(t);
  for (const arg of ['--config', '--model', '--wire', '--deb']) {
    await assert.rejects(setupChatGpt([arg, '--no-launch'], { home, env: {} }), /requires a value/);
  }
  assert.deepEqual(fs.readdirSync(home), []);
});

test('native launch rejects process creation and early exit failures', async () => {
  const { EventEmitter } = await import('node:events');
  for (const event of ['error', 'exit']) {
    await assert.rejects(launchChatGpt('/bad/app', [], { platform: 'linux', env: {}, spawnImpl: () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit(event, event === 'error' ? new Error('ENOENT') : 7));
      return child;
    } }), /ENOENT|exited during launch/);
  }
});

test('a malformed deb never deletes the previous unpacked app', async (t) => {
  const { unpackDeb } = await import('../lib/chatgpt.js');
  const home = temporaryHome(t), dest = path.join(home, 'app'), deb = path.join(home, 'bad.deb');
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dest, 'keep'), 'previous app');
  fs.writeFileSync(deb, 'not a deb');
  assert.throws(() => unpackDeb(deb, dest));
  assert.equal(fs.readFileSync(path.join(dest, 'keep'), 'utf8'), 'previous app');
  assert.ok(!fs.readdirSync(home).some(n => n.startsWith('.chatgpt-unpack-')));
});
