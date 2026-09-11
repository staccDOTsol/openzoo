import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { liveBalance } from '../lib/funding-status.js';
import { PayClient, UnderfundedError, BalanceUnavailableError, resetRailMemory } from '../lib/pay.js';
import { paymentError } from '../lib/payment-error.js';
import { settleFailCopy, whopFundBlurb } from '../lib/stripeOnramp.js';

test('a confirmed deposit is visible on the next refresh; outage never becomes zero', async () => {
 let balance=0, reads=0, time=1000;
 const state=liveBalance(async()=>{reads++;if(balance===null)throw Error('offline');return balance;},{now:()=>time});
 await state.refresh(); assert.equal(state.value,0);
 balance=5;time+=3001;await state.refresh();assert.equal(state.value,5);
 balance=null;time+=3001;await state.refresh();assert.equal(state.value,5);assert.equal(state.checkedAt,4001);
 assert.equal(reads,3);
});
test('payment failures stay failed, but stream readable copy without transport diagnostics', () => {
 const copy=settleFailCopy({error:'invalid_payload: contract call failed: execution reverted'});
 const message=copy.message+'\n\n'+whopFundBlurb('solana-address','base-address');
 let status, data;
 paymentError({writeHead:s=>status=s,end:s=>data=s},{url:'/v1/responses'},{body:JSON.stringify({stream:true,model:'test'})},copy.status,message);
 assert.equal(status,200);assert.match(data,/response.failed/);assert.match(data,/"status":"failed"/);
 assert.doesNotMatch(data,/402|payload|execution reverted|localhost|Hey — buy/);
 assert.match(data,/whop.com/);assert.match(data,/Solana deposit wallet \(USDC \/ LEOS \/ KISS\): solana-address/);assert.match(data,/Base \(USDC\): base-address/);
});
test('a failed payment method is not preferred over a newly funded Solana wallet', async () => {
 resetRailMemory(); const original=global.fetch;
 const sol={scheme:'exact',network:'solana:mainnet',asset:'sol',maxAmountRequired:'1',extra:{symbol:'USDC',billedUsd:0.01}};
 const base={...sol,network:'eip155:8453',asset:'base'};
 const quote={x402Version:1,accepts:[sol,base]};
 const client=new PayClient({keypair:Keypair.generate()});let funded=false;const attempts=[];
 client.buildPaymentFor=async a=>{if(a===sol || a.asset==='sol'){if(!funded)throw new UnderfundedError(a,0,client.address);}
 attempts.push(a.asset);return {header:a.asset};};
 global.fetch=async(_url,init)=>{
 const paid=Object.keys(init.headers).some(k=>/payment/i.test(k));
 return new Response(JSON.stringify(paid && funded ? {ok:true}:quote),{status:paid&&funded?200:402,headers:{'content-type':'application/json'}});
 };
 try {await client.fetch('https://example.test',{method:'POST',body:'{}'});funded=true;await client.fetch('https://example.test',{method:'POST',body:'{}'});assert.equal(attempts.at(-1),'sol');}
 finally{global.fetch=original;resetRailMemory();}
});
test('an unreadable EVM balance does not produce a signed payment', async () => {
 const original=global.fetch;global.fetch=async()=>{throw Error('RPC unavailable');};
 try{
 const client=new PayClient({keypair:Keypair.generate(),evmPrivateKey:'0x'+'11'.repeat(32)});
 await assert.rejects(client.buildPaymentFor({network:'eip155:8453',asset:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',maxAmountRequired:'1'}),BalanceUnavailableError);
 }finally{global.fetch=original;}
});
