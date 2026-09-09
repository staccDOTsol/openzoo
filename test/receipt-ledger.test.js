import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {receiptLedger} from '../lib/receipt-ledger.js';
test('receipts deduplicate across stream events and restart; savings use matching calls',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'receipts-'));const file=path.join(dir,'ledger.json');
 try {
 const ledger=receiptLedger(file);const receipt={charged:.001755121031965057,direct:.002258};
 ledger.record('tx-one',receipt);ledger.record('tx-one',receipt);ledger.record('tx-two',{charged:.002258,direct:.002258});
 const restored=receiptLedger(file);restored.record('tx-one',receipt);
 const t=restored.totals();assert.equal(t.billing.calls,2);assert.equal(t.comparison.calls,2);assert.equal(t.comparison.directUsd,.004516);assert.equal(t.billing.chargedUsd,.004013121031965057);
 assert.ok(Math.abs((t.comparison.directUsd-t.comparison.spentUsd)/t.comparison.directUsd*100-11.1354953)<.00001);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
