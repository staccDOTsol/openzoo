const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const stable = v => /^\d+\.\d+\.\d+$/.test(v);
const newer = (a, b) => {
  if (!stable(a) || !stable(b)) return false;
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i];
  return false;
};
function environment(node) {
  const env = { ...process.env, PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH || ''}` };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
}
function run(node, args, log, timeout = 600000) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, args, { env: environment(node), windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Operation timed out. Please try again.')); }, timeout);
    child.stdout.on('data', b => log(b.toString()));
    child.stderr.on('data', b => log(b.toString()));
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`OpenZoo exited with code ${code}`)); });
  });
}
async function resolveCLI(bundle, userData, log) {
  const node = path.join(bundle, 'runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  const npm = path.join(bundle, 'runtime', process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js');
  const pkg = dir => path.join(dir, 'node_modules/openzoo');
  let selected = path.join(bundle, 'sidecar');
  let version = JSON.parse(await fs.readFile(path.join(pkg(selected), 'package.json'), 'utf8')).version;
  const updates = path.join(userData, 'versions');
  await fs.mkdir(updates, { recursive: true });
  for (const v of await fs.readdir(updates)) {
    if (newer(v, version)) {
      try { if (JSON.parse(await fs.readFile(path.join(pkg(path.join(updates, v)), 'package.json'), 'utf8')).version === v) { selected = path.join(updates, v); version = v; } } catch {}
    }
  }
  try {
    log('Checking for the latest OpenZoo…\n');
    const response = await fetch('https://registry.npmjs.org/openzoo/latest', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Registry returned ${response.status}`);
    const latest = (await response.json()).version;
    if (newer(latest, version)) {
      const stage = await fs.mkdtemp(path.join(updates, '.install-'));
      try {
        await run(node, [npm, 'install', '--prefix', stage, '--registry=https://registry.npmjs.org', '--omit=dev', '--no-audit', '--no-fund', `openzoo@${latest}`], log);
        await run(node, [path.join(stage, 'node_modules/dugite/script/download-git.js')], log);
        await run(node, [path.join(pkg(stage), 'bin/openzoo.js'), '--help'], () => {}, 30000);
        await fs.rename(stage, path.join(updates, latest));
        selected = path.join(updates, latest); version = latest;
      } finally { await fs.rm(stage, { recursive: true, force: true }); }
    }
  } catch (e) { log(`Update unavailable (${e.message}). Using installed OpenZoo ${version}.\n`); }
  log(`Starting OpenZoo ${version}…\n`);
  return { node, cli: path.join(pkg(selected), 'bin/openzoo.js') };
}
module.exports = { newer, environment, resolveCLI, run };
