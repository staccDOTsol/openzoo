import { Connection, PublicKey } from '@solana/web3.js';
const c = new Connection(process.env.OPENZOO_RPC || 'https://api.mainnet-beta.solana.com', 'confirmed');
const PROG = new PublicKey('FrSERTNCPvTtaDS9AvQp9u1nYGzXDb3kC9MdL8Xxn2NE');
const sigs = await c.getSignaturesForAddress(PROG, { limit: 15 });
console.log('recent sigs:', sigs.map((s) => `${s.signature.slice(0, 12)}… err=${!!s.err}`).join('\n'));
for (const s of sigs) {
  if (s.err) continue;
  const tx = await c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
  if (!tx) continue;
  const msg = tx.transaction.message;
  const keys = msg.staticAccountKeys || msg.accountKeys;
  const instrs = msg.compiledInstructions || msg.instructions;
  for (const ix of instrs) {
    const pid = keys[ix.programIdIndex];
    if (!pid.equals(PROG)) continue;
    const data = Buffer.from(ix.data instanceof Uint8Array ? ix.data : Buffer.from(ix.data, 'base64'));
    console.log('\n=== tx', s.signature);
    console.log('data hex:', data.toString('hex'), 'len', data.length);
    const idxs = ix.accountKeyIndexes || ix.accounts;
    idxs.forEach((ai, i) => console.log(`  acct[${i}] ${keys[ai].toBase58()}${msg.isAccountSigner?.(ai) ? ' (signer)' : ''}${msg.isAccountWritable?.(ai) ? ' (w)' : ''}`));
    console.log('logs:', (tx.meta?.logMessages || []).filter((l) => l.includes('Program log') || l.includes(PROG.toBase58())).slice(0, 12).join('\n'));
  }
  break; // first successful is enough to start
}
