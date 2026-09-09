import fs from 'node:fs';
import path from 'node:path';
export function receiptLedger(file, base = {}) {
  let state = { base, receipts: {} };
  try { const saved=JSON.parse(fs.readFileSync(file,'utf8')); if(saved.receipts && saved.base)state=saved; } catch {}
  const totals = () => {
    const billing={chargedUsd:state.base.billing?.chargedUsd || 0,calls:state.base.billing?.calls || 0};
    const comparison={spentUsd:state.base.comparison?.spentUsd || 0,directUsd:state.base.comparison?.directUsd || 0,calls:state.base.comparison?.calls || 0};
    for(const r of Object.values(state.receipts)) {
      billing.chargedUsd+=r.charged;billing.calls++;
      if(r.direct!==null){comparison.spentUsd+=r.charged;comparison.directUsd+=r.direct;comparison.calls++;}
    }
    return {billing,comparison};
  };
  return { totals, record(id, receipt) {
    if(!id || typeof receipt.charged!=='number' || !Number.isFinite(receipt.charged) || receipt.charged<0) return totals();
    state.receipts[id]={charged:receipt.charged,direct:typeof receipt.direct==='number'&&Number.isFinite(receipt.direct)&&receipt.direct>=0?receipt.direct:null};
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state),{mode:0o600});fs.renameSync(tmp,file);
    return totals();
  }};
}
