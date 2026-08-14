import { Connection, PublicKey } from '@solana/web3.js';
const RPC = process.env.OPENZOO_RPC || 'https://api.mainnet-beta.solana.com';
const c = new Connection(RPC, 'confirmed');
const PROG = new PublicKey('FrSERTNCPvTtaDS9AvQp9u1nYGzXDb3kC9MdL8Xxn2NE');
const YUSDCX = new PublicKey('6ZjjxcoicqM4nniddkuPVwew4PDwY3swbfHsGbCuLuTv');
const ESCROW = new PublicKey('2qLm8aCvn6gQVUFeQ7EC5J62Y95gFzc3vReHzD5d5Gj2');

const prog = await c.getAccountInfo(PROG);
console.log('program:', { executable: prog?.executable, owner: prog?.owner?.toBase58(), len: prog?.data?.length });

const mintAcc = await c.getParsedAccountInfo(YUSDCX);
console.log('yUSDCx mint:', JSON.stringify(mintAcc.value?.data?.parsed?.info, null, 1).slice(0, 2000));

const esc = await c.getParsedAccountInfo(ESCROW);
console.log('escrow:', JSON.stringify(esc.value?.data?.parsed?.info, null, 1));

// anchor IDL account
const [base] = PublicKey.findProgramAddressSync([], PROG);
const idlAddr = await PublicKey.createWithSeed(base, 'anchor:idl', PROG);
const idl = await c.getAccountInfo(idlAddr);
console.log('idl account:', idlAddr.toBase58(), idl ? `len=${idl.data.length}` : 'none');
if (idl) {
  // anchor idl account: 8 disc + 32 authority + 4 len + zlib data
  const len = idl.data.readUInt32LE(40);
  const zlib = await import('node:zlib');
  const json = zlib.inflateSync(idl.data.subarray(44, 44 + len)).toString('utf8');
  console.log('IDL:', json.slice(0, 4000));
}
