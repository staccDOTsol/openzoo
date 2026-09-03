const { ensureCloudflared, startHealthyTunnel, probeTunnel } = await import('./lib/tunnel.js');
const log = (m) => console.log('  ' + m);
const bin = await ensureCloudflared(log);
const t0 = Date.now();
try {
  const { url, rung, proc } = await startHealthyTunnel(bin, 8402, log);
  console.log(`\nRESULT: ${url}`);
  console.log(`rung  : ${rung}`);
  console.log(`took  : ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log('verify:', await probeTunnel(url, { tries: 2 }) ? 'SERVES 200' : 'still dead');
  try { proc.kill(); } catch {}
  process.exit(0);
} catch (e) { console.log('ALL RUNGS FAILED:', e.message); process.exit(1); }
