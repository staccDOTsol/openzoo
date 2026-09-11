import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {FUNDING_ASSETS,fundingLine} from '../lib/config.js';
import {PayClient} from '../lib/pay.js';
import {whopFundBlurb} from '../lib/stripeOnramp.js';
const raw=['EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump','7K2iAPzHddrghwBF7S7oA9qHr7dDR4QvFmdD1sZgRJxF','5xgsnby6P9zqGK71J7H4yJLxzqPvNbC7rDZxNzjHmj7e'];
test('old unwrapped quotes are rejected before reading balances or signing',async()=>{
 const client=new PayClient({keypair:Keypair.generate()});
 for(const asset of raw)await assert.rejects(client.buildPaymentFor({network:'solana:mainnet',asset,maxAmountRequired:'1'}),/Unwrapped project tokens/);
});
test('funding copy links only cooked mints and keeps native USDC',()=>{
 const copy=whopFundBlurb('deposit','base')+' '+fundingLine('deposit');
 for(const mint of raw){assert.ok(!FUNDING_ASSETS.some(a=>a.mint===mint));assert.ok(!copy.includes(mint));}
 for(const a of FUNDING_ASSETS.filter(a=>a.symbol!=='USDC'))assert.ok(copy.includes('https://eat.ag/cook/'+a.mint));
 assert.match(copy,/USDC stays native/);
});
