const { ensureCloudflared, startHealthyTunnel } = await import('./lib/tunnel.js');
const bin = await ensureCloudflared(() => {});
const t0 = Date.now();
try {
  const w = await startHealthyTunnel(bin, 8402, (m) => console.log('  ' + m));
  console.log(`\nWON: ${w.url}\nrung: ${w.rung}\ntook: ${((Date.now()-t0)/1000).toFixed(1)}s`);
  try { w.proc.kill(); } catch {}
} catch (e) { console.log(`FAILED after ${((Date.now()-t0)/1000).toFixed(1)}s: ${e.message}`); }
process.exit(0);
