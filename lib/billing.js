const money = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;

// Only final, explicitly reported charges. Never substitute upstream cost or a quote.
export function finalBilling(x = {}, usage = {}) {
  const charged = [usage.billedUsd, x.billedActualUsd, x.settledBilledUsd, x.chargedUsd,
    x.settledUsd, usage.cost_details?.upstream_inference_cost != null ? usage.cost : null].map(money).find(n => n !== null) ?? null;
  const direct = x.pricing === 'counterfactual' ? money(x.directUsd) : null;
  return { charged, direct, upstream: money(usage.cost_details?.upstream_inference_cost) };
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
          if (value.usage || value.x402) onReceipt({ ...value.x402, usage: value.usage });
        }
      } catch { /* Not a billing event. */ }
    }
    if (pending.length > 2_000_000) pending = '';
  };
}
