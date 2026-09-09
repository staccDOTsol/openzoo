const usd = n => typeof n === 'number' && Number.isFinite(n) ? '$' + Math.abs(n).toFixed(Math.abs(n) < .01 && n !== 0 ? 4 : 2) : '—';
window.savings.listen(d => {
  for (const [id, value] of [['wallet',d.walletUsd],['credit',d.creditUsd],['spent',d.spendUsd],['direct',d.directUsd]]) document.getElementById(id).textContent=usd(value);
  const comparable=typeof d.directUsd==='number' && typeof d.spendUsd==='number' && (d.directUsd>0 || d.spendUsd===0);
  const saved=comparable ? d.directUsd-d.spendUsd : null;
  document.getElementById('saved').textContent=usd(saved);
  document.getElementById('saving-label').textContent=saved!==null && saved<0 ? 'Extra cost' : 'Saved';
  document.getElementById('state').textContent=d.online ? 'Balance updates automatically' : 'Reconnecting · showing last known amounts';
});
document.getElementById('close').addEventListener('click',()=>window.savings.close());
