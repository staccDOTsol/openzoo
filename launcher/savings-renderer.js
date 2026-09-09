const usd = n => typeof n === 'number' && Number.isFinite(n) ? '$' + Math.abs(n).toFixed(Math.abs(n) < .01 && n !== 0 ? 4 : 2) : '—';
window.savings.listen(d => {
  for (const [id, value] of [['wallet',d.walletUsd],['credit',d.creditUsd],['spent',d.billing?.calls > 0 ? d.billing.chargedUsd : null],['direct',d.comparison?.calls > 0 ? d.comparison.directUsd : null]]) document.getElementById(id).textContent=usd(value);
  const saved=d.comparison?.calls > 0 ? d.comparison.directUsd-d.comparison.spentUsd : null;
  const pct=d.comparison?.directUsd > 0 && saved !== null ? Math.abs(saved)/d.comparison.directUsd*100 : null;
  document.getElementById('saved').textContent=usd(saved)+(pct===null?'':` (${pct.toFixed(1)}%)`);
  document.getElementById('saving-label').textContent=saved!==null && saved<0 ? 'Extra cost' : 'Saved';
  document.getElementById('state').textContent=d.online ? (d.billing?.calls > 0 ? 'Final charges · saved receipts' : 'Waiting for final billing · balance is live') : 'Reconnecting · showing last known amounts';
});
document.getElementById('close').addEventListener('click',()=>window.savings.close());
