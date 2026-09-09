import test from 'node:test';
import assert from 'node:assert/strict';
import { finalBilling, billingObserver } from '../lib/billing.js';
test('a quote and internal direct cost do not establish final charge or savings', () => {
 assert.deepEqual(finalBilling({ billedUsd: .6, directUsd: .6, pricing: 'markup' }), {charged:null,direct:null,upstream:null});
});
test('final billed cost stays distinct from provider cost and counterfactual', () => {
 assert.deepEqual(finalBilling({pricing:'counterfactual',directUsd:.8}, {billedUsd:.04,cost:.04,cost_details:{upstream_inference_cost:.01}}), {charged:.04,direct:.8,upstream:.01});
});
test('Responses final usage and trailing receipt survive fragmented streams', () => {
 const events=[];const observe=billingObserver(x=>events.push(x));
 const stream='data: '+JSON.stringify({type:'response.completed',response:{usage:{billedUsd:.04,cost_details:{upstream_inference_cost:.01}}}})+'\n\n: x402 '+JSON.stringify({pricing:'counterfactual',directUsd:.8})+'\n';
 for(let i=0;i<stream.length;i+=3)observe(stream.slice(i,i+3));
 assert.equal(events.length,2);assert.equal(events[0].usage.billedUsd,.04);assert.equal(events[1].directUsd,.8);
});
