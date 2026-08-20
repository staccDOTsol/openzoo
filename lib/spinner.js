/**
 * Tiny TTY-aware progress line for long waits (big-body upload, zoo pricing,
 * payment settle). No deps: setInterval + \r rewrite on a TTY, plain periodic
 * status lines when piped.
 *
 *   const spin = startSpinner('uploading 3.8MB body');
 *   spin.update('zoo pricing 965k tokens');
 *   spin.stop();            // clears the line; caller prints the result
 */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function startSpinner(initialLabel, { stream = process.stdout } = {}) {
  const t0 = Date.now();
  let label = initialLabel;
  let frame = 0;
  let stopped = false;
  const secs = () => Math.round((Date.now() - t0) / 1000);

  let timer;
  if (stream.isTTY) {
    timer = setInterval(() => {
      frame = (frame + 1) % FRAMES.length;
      stream.write(`\r\x1b[2K${FRAMES[frame]} ${label}… ${secs()}s`);
    }, 100);
  } else {
    let lastPrinted = -5;
    timer = setInterval(() => {
      if (secs() - lastPrinted >= 5) {
        lastPrinted = secs();
        stream.write(`${label}… ${lastPrinted}s\n`);
      }
    }, 1000);
  }
  timer.unref?.();

  return {
    update(newLabel) { label = newLabel; },
    elapsed: secs,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (stream.isTTY) stream.write('\r\x1b[2K');
    },
  };
}

/**
 * POST a large JSON body with an upload-completion callback, so callers can
 * flip a spinner label from "uploading" to "server working". Tries a streamed
 * (chunked) upload — the pull() callback tells us when the socket drained the
 * body — and falls back to a plain buffered POST if the runtime or server
 * doesn't take streamed request bodies.
 */
export async function postWithUploadSignal(url, bodyString, { headers = {}, onUploaded } = {}) {
  const buf = Buffer.from(bodyString);
  if (typeof ReadableStream === 'function' && buf.length > 262144) {
    try {
      let off = 0;
      const stream = new ReadableStream({
        pull(c) {
          if (off >= buf.length) { c.close(); onUploaded?.(); return; }
          const end = Math.min(off + 65536, buf.length);
          c.enqueue(buf.subarray(off, end));
          off = end;
        },
      });
      const { timedFetch } = await import('./upstream.js');
      const r = await timedFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: stream,
        duplex: 'half',
      });
      // 411/413 = server refused the chunked upload; retry buffered below.
      if (r.status !== 411 && r.status !== 413) return r;
    } catch { /* runtime without duplex streams — fall through */ }
  }
  const { timedFetch } = await import('./upstream.js');
  const r = await timedFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: buf,
  });
  onUploaded?.();
  return r;
}
