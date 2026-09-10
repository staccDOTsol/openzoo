const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function launcher({ packaged = true, savingsOnly = false, lockedProfiles = new Set(), loading = false } = {}) {
  const app = new EventEmitter();
  const paths = { appData: '/app-data', userData: '/app-data/openzoo-launcher' };
  const state = { windows: [], handlers: new Map(), savings: 0, writes: [], runs: [] };
  Object.assign(app, {
    isPackaged: packaged,
    getPath: name => paths[name],
    setPath: (name, value) => { paths[name] = value; },
    isReady: () => true,
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => {
      state.lockPath = paths.userData;
      return !lockedProfiles.has(paths.userData);
    },
    quit: () => { state.quit = true; },
  });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      this.webContents.send = () => {};
      state.windows.push(this);
    }
    isDestroyed() { return !!this.destroyed; }
    isMinimized() { return !!this.minimized; }
    restore() { this.minimized = false; this.restored = true; }
    show() { this.shown = true; }
    focus() { this.focused = true; }
    loadFile(file) { this.file = file; }
    close() { this.destroyed = true; this.emit('closed'); }
  }
  const pillContents = new EventEmitter();
  pillContents.isLoading = () => loading;
  const modules = {
    electron: { app, BrowserWindow, ipcMain: { handle: (name, handler) => {
      assert.equal(state.handlers.has(name), false, 'IPC handler is registered only once');
      state.handlers.set(name, handler);
    } } },
    'node:path': path,
    'node:fs': { mkdirSync() {}, writeFileSync: (...args) => state.writes.push(args) },
    './runtime.cjs': { resolveCLI: async () => ({ node: '/node', cli: '/cli' }), run: async (...args) => state.runs.push(args.slice(0, 2)) },
    './savings.cjs': { showSavings: () => { state.savings++; return { webContents: pillContents }; } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8'), {
    require: name => { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; },
    __dirname,
    process: { argv: savingsOnly ? ['launcher', '--savings-only'] : ['launcher'], env: {}, resourcesPath: '/resources' },
  });
  await Promise.resolve();
  return { app, state, pillContents };
}

test('an existing npm overlay cannot take the packaged launcher lock', async () => {
  const overlay = await launcher({ packaged: false, savingsOnly: true });
  const desktop = await launcher({ lockedProfiles: new Set([overlay.state.lockPath]) });
  assert.equal(overlay.state.lockPath, '/app-data/openzoo-launcher');
  assert.equal(desktop.state.lockPath, '/app-data/openzoo-launcher-desktop');
  assert.equal(desktop.state.quit, undefined);
  assert.equal(desktop.state.windows.length, 1);
  assert.equal(overlay.state.windows.length, 0);
});

test('a second packaged launcher still hands off to the first', async () => {
  const first = await launcher();
  const second = await launcher({ lockedProfiles: new Set([first.state.lockPath]) });
  assert.equal(second.state.quit, true);
  assert.equal(second.state.windows.length, 0);
});

test('normal launch after savings-only startup creates a functioning launcher window', async () => {
  const { app, state } = await launcher({ savingsOnly: true });
  assert.equal(state.windows.length, 0);
  app.emit('second-instance', {}, ['launcher'], '/');
  await Promise.resolve();
  assert.equal(state.windows.length, 1);
  await state.handlers.get('launch')({ sender: state.windows[0].webContents }, 'chatgpt');
  assert.equal(JSON.stringify(state.runs), JSON.stringify([['/node', ['/cli', 'chatgpt', '--no-pill']]]));
});

test('relaunch restores a minimized window and recreates a closed window', async () => {
  const { app, state } = await launcher();
  const first = state.windows[0];
  first.minimized = true;
  app.emit('second-instance', {}, ['launcher'], '/');
  await Promise.resolve();
  assert.equal(state.windows.length, 1);
  assert.equal(first.restored && first.shown && first.focused, true);
  first.close();
  app.emit('second-instance', {}, ['launcher'], '/');
  await Promise.resolve();
  assert.equal(state.windows.length, 2);
  assert.equal(state.handlers.size, 1);
});

test('macOS activation reopens the packaged launcher, including savings-only startup', async () => {
  const { app, state } = await launcher({ savingsOnly: true });
  app.emit('activate');
  assert.equal(state.windows.length, 1);
  state.windows[0].close();
  app.emit('activate');
  assert.equal(state.windows.length, 2);
  const overlay = await launcher({ packaged: false, savingsOnly: true });
  overlay.app.emit('activate');
  assert.equal(overlay.state.windows.length, 0, 'standalone overlay has no bundled launcher runtime');
});

test('a second savings request waits for the existing overlay to load before acknowledging', async () => {
  const { app, state, pillContents } = await launcher({ loading: true });
  app.emit('second-instance', {}, ['launcher', '--savings-only'], '/', { savingsReady: '/ready' });
  await Promise.resolve();
  assert.equal(state.windows.length, 1);
  assert.equal(state.writes.length, 0);
  pillContents.emit('did-finish-load');
  assert.deepEqual(state.writes, [['/ready', 'ready']]);
});

test('only the main launcher renderer can start ChatGPT', async () => {
  const { state } = await launcher();
  const launch = state.handlers.get('launch');
  await assert.rejects(launch({ sender: {} }, 'chatgpt'), /Launch unavailable/);
  await assert.rejects(launch({ sender: state.windows[0].webContents }, 'other'), /Launch unavailable/);
  state.windows[0].close();
  await assert.rejects(launch({ sender: {} }, 'chatgpt'), /Launch unavailable/);
  assert.equal(state.runs.length, 0);
});
