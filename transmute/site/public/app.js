const out = (id, v) => { document.getElementById(id).textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2); };
async function call(id, url, init) {
  out(id, '…');
  try {
    const r = await fetch(url, init);
    const sim = r.headers.get('x-zoo-simulated'), cu = r.headers.get('x-zoo-cu'), sig = r.headers.get('x-zoo-signature');
    let body; try { body = await r.json(); } catch { body = await r.text(); }
    out(id, { status: r.status, simulated: sim, computeUnits: cu, signature: sig, body });
  } catch (e) { out(id, 'error: ' + e.message); }
}
document.getElementById('hello').onclick = () => call('o-hello', '/api/hello?name=' + encodeURIComponent(document.getElementById('name').value || 'anon'));
document.getElementById('hits-get').onclick = () => call('o-hits', '/api/hits');
document.getElementById('hits-post').onclick = () => call('o-hits', '/api/hits', { method: 'POST' });
document.getElementById('time').onclick = () => call('o-time', '/api/time');
document.getElementById('echo').onclick = () => call('o-echo', '/api/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 1, b: 'two' }) });
fetch('/.zoo/status').then((r) => r.json()).then((s) => out('o-status', s)).catch(() => {});
