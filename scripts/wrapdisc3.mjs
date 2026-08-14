import { Connection, PublicKey } from '@solana/web3.js';
const c = new Connection(process.env.OPENZOO_RPC || 'https://api.mainnet-beta.solana.com', 'confirmed');
const PROG = new PublicKey('FrSERTNCPvTtaDS9AvQp9u1nYGzXDb3kC9MdL8Xxn2NE');
const sigs = (await c.getSignaturesForAddress(PROG, { limit: 12 })).filter((s) => !s.err);
for (const s of sigs.slice(0, 4)) {
  const tx = await c.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
  if (!tx) continue;
  console.log('\n=== tx', s.signature.slice(0, 20) + '…', 'fee payer:', tx.transaction.message.accountKeys[0].pubkey.toBase58());
  tx.transaction.message.instructions.forEach((ix, i) => {
    if (ix.parsed) {
      console.log(` [${i}] ${ix.program}: ${ix.parsed.type}`, JSON.stringify(ix.parsed.info).slice(0, 260));
    } else {
      console.log(` [${i}] program ${ix.programId.toBase58()} data(b58) ${ix.data} accts ${ix.accounts.map((a) => a.toBase58().slice(0, 6)).join(',')}`);
    }
  });
  (tx.meta?.innerInstructions || []).forEach((inner) => {
    inner.instructions.forEach((ix) => {
      if (ix.parsed) console.log(`   inner@${inner.index}: ${ix.program}.${ix.parsed.type}`, JSON.stringify(ix.parsed.info).slice(0, 220));
    });
  });
}
