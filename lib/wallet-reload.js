import fs from 'node:fs';
import crypto from 'node:crypto';
/** Swap whole clients, never mutate the signer of an in-flight request. */
export function walletReloader(initial, { file, load }) {
  const fingerprint = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  let current = initial, stamp = fingerprint();
  return () => {
    try {
      const next = fingerprint();
      if (next !== stamp) {
        const replacement = load();
        // load may migrate the legacy array format after validating it.
        stamp = fingerprint();
        current = replacement;
      }
      return current;
    } catch {
      // Do not print parser errors containing secret-key bytes, or keep paying
      // from the old wallet while a replacement is missing/partially copied.
      throw new Error('Could not load wallet.json. Finish copying a valid OpenZoo wallet file; payments are paused until it is ready.');
    }
  };
}
