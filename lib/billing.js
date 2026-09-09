const money = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;

// Only final, explicitly reported charges. Never substitute upstream cost or a quote.
export function finalBilling(x = {}, usage = {}) {
  const receipt = x._completedResponse === true || x.settle?.success === true;
  const charged = [usage.billedUsd, x.billedActualUsd, x.settledBilledUsd, x.chargedUsd,
    x.settledUsd, receipt ? x.billedUsd : null,
    usage.cost_details?.upstream_inference_cost != null ? usage.cost : null].map(money).find(n => n !== null) ?? null;
  const direct = receipt ? money(x.directUsd) : null;
  const upstream = money(usage.cost_details?.upstream_inference_cost) ?? (receipt ? money(x.actualUsd) : null);
  return { charged, direct, upstream };
}

// Observe billing without retaining prompts, output text, or changing the stream.
export function billingObserver(onReceipt) {
  let pending = '';
  return chunk => {
    pending += chunk;
    let i;
    while ((i = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, i).trimEnd(); pending = pending.slice(i + 1);
      try {
        if (line.startsWith(': x402 ')) onReceipt(JSON.parse(line.slice(7)));
        else if (line.startsWith('data:')) {
          const event = JSON.parse(line.slice(5).trim());
          const value = event.response || event;
          if (value.usage || value.x402) onReceipt({ ...value.x402, usage: value.usage, _completedResponse: event.type === 'response.completed' || value.status === 'completed' });
        }
      } catch { /* Not a billing event. */ }
    }
    if (pending.length > 2_000_000) pending = '';
  };
}
