let onboarding = false;
const finishOnboarding = () => {
  try { localStorage.setItem('openzoo-onboarded-v1','yes'); } catch {}
  onboarding=false;
  document.getElementById('welcome').hidden=true;
  document.getElementById('totals').hidden=false;
  document.getElementById('later').hidden=true;
  document.getElementById('funding').hidden=true;
  window.savings.back();
};
const usd = n => typeof n === 'number' && Number.isFinite(n) ? '$' + Math.abs(n).toFixed(Math.abs(n) < .01 && n !== 0 ? 4 : 2) : '—';
window.savings.listen(d => {
  if (onboarding) {
    const funded=d.online && ((d.walletUsd || 0)+(d.creditUsd || 0)>0);
    document.getElementById("back").textContent=funded ? "Ready — start chatting" : "Waiting for funds…";
    document.getElementById("back").disabled=!funded;
  }
  for (const [id, value] of [['wallet',d.walletUsd],['credit',d.creditUsd],['spent',d.billing?.calls > 0 ? d.billing.chargedUsd : null],['direct',d.comparison?.calls > 0 ? d.comparison.directUsd : null]]) document.getElementById(id).textContent=usd(value);
  const saved=d.comparison?.calls > 0 ? d.comparison.directUsd-d.comparison.spentUsd : null;
  const pct=d.comparison?.directUsd > 0 && saved !== null ? Math.abs(saved)/d.comparison.directUsd*100 : null;
  document.getElementById('saved').textContent=usd(saved)+(pct===null?'':` (${pct.toFixed(1)}%)`);
  document.getElementById('saving-label').textContent=saved!==null && saved<0 ? 'Extra cost' : 'Saved';
  document.getElementById('state').textContent=d.online ? (d.billing?.calls > 0 ? 'Final charges · saved receipts' : 'Waiting for final billing · balance is live') : 'Reconnecting · showing last known amounts';
});
document.getElementById('close').addEventListener('click',()=>window.savings.close());

document.getElementById('deposit').addEventListener('click', () => {
  try { onboarding = localStorage.getItem('openzoo-onboarded-v1') !== 'yes'; } catch {}
  document.getElementById('welcome').hidden=!onboarding;
  document.getElementById('totals').hidden=onboarding;
  document.getElementById('later').hidden=!onboarding;
  document.getElementById('funding').hidden=false;
  if (!onboarding) { document.getElementById('back').disabled=false; document.getElementById('back').textContent='Back to savings'; }
  window.savings.deposit();
});
window.savings.wallet(d => {
  document.getElementById('fund-status').textContent=d.error || 'Fund this wallet. Click an address to copy it.';
  for (const chain of ['solana','evm']) {
    document.getElementById(chain+'-address').textContent=d[chain] || '';
    document.getElementById('copy-'+chain).disabled=!d[chain];
  }
});
for (const chain of ['solana','evm']) document.getElementById('copy-'+chain).addEventListener('click',()=>window.savings.copy(chain));
window.savings.copied(chain => { document.getElementById('fund-status').textContent=(chain==='solana'?'Solana':'Base')+' address copied.'; });
document.getElementById('card').addEventListener('click',()=>window.savings.card());
document.getElementById('back').addEventListener('click',finishOnboarding);
document.getElementById('later').addEventListener('click',finishOnboarding);
