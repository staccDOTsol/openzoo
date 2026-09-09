// Run on the target OS/architecture. Bundle official Node LTS with npm and this release's CLI.
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
process.chdir(root);
async function fetchOK(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r;
}
const releases = await (await fetchOK('https://nodejs.org/dist/index.json')).json();
const version = releases.find(r => r.lts).version;
const base = `node-${version}-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const archive = `${base}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
await mkdir('bundle', { recursive: true });
const bytes = Buffer.from(await (await fetchOK(`https://nodejs.org/dist/${version}/${archive}`)).arrayBuffer());
const sums = await (await fetchOK(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).text();
const expected = sums.split('\n').find(line => line.endsWith(`  ${archive}`))?.split(' ')[0];
if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Node checksum mismatch');
await writeFile(archive, bytes);
await rm('bundle/runtime', { recursive: true, force: true });
if (process.platform === 'win32') {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath bundle -Force`]);
  const { rename } = await import('node:fs/promises');
  await rename(`bundle/${base}`, 'bundle/runtime');
} else {
  await mkdir('bundle/runtime', { recursive: true });
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', 'bundle/runtime']);
}
await rm(archive);
const node = path.resolve(process.platform === 'win32' ? 'bundle/runtime/node.exe' : 'bundle/runtime/bin/node');
const npm = path.resolve(process.platform === 'win32' ? 'bundle/runtime/node_modules/npm/bin/npm-cli.js' : 'bundle/runtime/lib/node_modules/npm/bin/npm-cli.js');
const env = { ...process.env, PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH}` };
delete env.ELECTRON_RUN_AS_NODE;
const packed = JSON.parse(execFileSync(node, [npm, 'pack', '..', '--json', '--pack-destination', root], { env, encoding: 'utf8' }))[0].filename;
await mkdir('bundle/sidecar', { recursive: true });
execFileSync(node, [npm, 'install', '--prefix', path.resolve('bundle/sidecar'), '--omit=dev', '--no-audit', '--no-fund', path.resolve(packed)], { env, stdio: 'inherit' });
await rm(packed);
// npm 11+ may defer dependency install scripts; explicitly prepare bundled Git.
execFileSync(node, [path.resolve('bundle/sidecar/node_modules/dugite/script/download-git.js')], { env, stdio: 'inherit' });
execFileSync(node, [path.resolve('bundle/sidecar/node_modules/openzoo/bin/openzoo.js'), '--help'], { env, stdio: 'inherit' });
await writeFile('bundle/runtime-version.json', JSON.stringify({ node: version, platform: process.platform, arch: process.arch }));
