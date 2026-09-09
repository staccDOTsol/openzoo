// osx-sign walks every dependency file with unbounded binary probes. Limit the
// probes (not the signing itself) so a full Node/npm sidecar cannot exhaust FDs.
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(path.dirname(require.resolve('@electron/osx-sign')), 'util.js');
let source = fs.readFileSync(file, 'utf8');
const probe = 'await (0, isbinaryfile_1.isBinaryFile)(filePath)';
if (!source.includes('openzooBinaryQueue')) {
  if (source.split(probe).length !== 2) throw new Error('osx-sign binary probe changed; review signing patch');
  source = source.replace(probe, 'await openzooBinaryProbe(filePath)');
  source += `\nlet openzooBinaryQueue = Promise.resolve();
function openzooBinaryProbe(filePath) {
  const result = openzooBinaryQueue.then(() => (0, isbinaryfile_1.isBinaryFile)(filePath));
  openzooBinaryQueue = result.catch(() => {});
  return result;
}\n`;
  fs.writeFileSync(file, source);
}
