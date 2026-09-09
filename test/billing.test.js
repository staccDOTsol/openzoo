import test from 'node:test';
import assert from 'node:assert/strict';
import { finalBilling, billingObserver } from '../lib/billing.js';
test('a quote and internal direct cost do not establish final charge or savings', () => {
 assert.deepEqual(finalBilling({ billedUsd: .6, directUsd: .6, pricing: 'markup' }), {charged:null,direct:null,upstream:null});
});
test('final billed cost stays distinct from provider cost and counterfactual', () => {
 assert.deepEqual(finalBilling({pricing:'counterfactual',directUsd:.8,_completedResponse:true}, {billedUsd:.04,cost:.04,cost_details:{upstream_inference_cost:.01}}), {charged:.04,direct:.8,upstream:.01});
});
test('Responses final usage and trailing receipt survive fragmented streams', () => {
 const events=[];const observe=billingObserver(x=>events.push(x));
 const stream='data: '+JSON.stringify({type:'response.completed',response:{usage:{billedUsd:.04,cost_details:{upstream_inference_cost:.01}}}})+'\n\n: x402 '+JSON.stringify({pricing:'counterfactual',directUsd:.8,_completedResponse:true})+'\n';
 for(let i=0;i<stream.length;i+=3)observe(stream.slice(i,i+3));
 assert.equal(events.length,2);assert.equal(events[0].usage.billedUsd,.04);assert.equal(events[1].directUsd,.8);
});

test('captured Responses receipt reports actual charge and comparison even on markup pricing', () => {
 const receipt={billedUsd:0.001755121031965057,actualUsd:0.003335,pricing:'markup',directUsd:0.002258,settle:{success:true}};
 const received=[];const observe=billingObserver(x=>received.push(finalBilling(x,x.usage)));
 for (const type of ['response.created','response.in_progress','response.completed']) {
  observe('data: '+JSON.stringify({type,response:{x402:receipt,usage:{input_tokens:241,output_tokens:4,total_tokens:245}}})+'\n\n');
 }
 assert.equal(received.length,3);
 for(const r of received)assert.deepEqual(r,{charged:receipt.billedUsd,direct:receipt.directUsd,upstream:receipt.actualUsd});
});
