import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
const c = new Connection(process.env.OPENZOO_RPC || 'https://api.mainnet-beta.solana.com', 'confirmed');
const PROG = new PublicKey('FrSERTNCPvTtaDS9AvQp9u1nYGzXDb3kC9MdL8Xxn2NE');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const YUSDCX = new PublicKey('6ZjjxcoicqM4nniddkuPVwew4PDwY3swbfHsGbCuLuTv');
const PDA = new PublicKey('EBGYMEEEPKu7szPUbnbp2h63azY9Sj9GR4MA2Ms6Quoi');
const ME = new PublicKey('HLyPVoGK3yxkUoCybWQiHXETEPA8KxPdpQ1Q9pVGGhku');

// is escrow the PDA's USDC ATA?
const ataOfPda = getAssociatedTokenAddressSync(USDC, PDA, true, TOKEN_PROGRAM_ID);
console.log('PDA USDC ATA:', ataOfPda.toBase58(), '== escrow?', ataOfPda.toBase58() === '2qLm8aCvn6gQVUFeQ7EC5J62Y95gFzc3vReHzD5d5Gj2');

// seed guesses for the PDA
for (const seeds of [[YUSDCX.toBuffer()], [USDC.toBuffer()], [Buffer.from('authority')], [Buffer.from('auth')], [Buffer.from('vault')], [Buffer.from('mint')], [Buffer.from('wrap')], [Buffer.from('authority'), YUSDCX.toBuffer()], [Buffer.from('vault'), YUSDCX.toBuffer()], [YUSDCX.toBuffer(), Buffer.from('authority')], [Buffer.from('mint-authority')], [Buffer.from('escrow'), YUSDCX.toBuffer()]]) {
  try {
    const [addr, bump] = PublicKey.findProgramAddressSync(seeds, PROG);
    if (addr.equals(PDA)) console.log('PDA SEEDS FOUND:', seeds.map(String), 'bump', bump);
  } catch {}
}

// user's wallet holdings
const sol = await c.getBalance(ME);
console.log('SOL:', sol / 1e9);
for (const [name, mint, prog] of [['USDC', USDC, TOKEN_PROGRAM_ID], ['yUSDCx', YUSDCX, TOKEN_2022_PROGRAM_ID]]) {
  try {
    const ata = getAssociatedTokenAddressSync(mint, ME, false, prog);
    const b = await c.getTokenAccountBalance(ata);
    console.log(`${name}:`, b.value.uiAmountString, 'raw', b.value.amount);
  } catch (e) { console.log(`${name}: no account`); }
}
