/**
 * @openzoobot public receipt. X collapses single newlines into one
 * paragraph; join with a blank line so PAID / WOULDA / tx stay stacked.
 * `(this call) openzoo.fun` stays on the PAID line — never split.
 */

const HARD = '\n\n';

export function receiptLines({
  paid = '0.004',
  woulda = '0.03',
  wouldaLabel = 'grok.com / xAI API',
  tx = '',
  model = 'grok-4.6 @ openzoo',
} = {}) {
  const paidStr = String(paid).replace(/^\$/, '');
  const wouldaStr = String(woulda).replace(/^\$/, '');
  const lines = [
    model,
    `**PAID** $${paidStr} x402 (this call) openzoo.fun`,
    `**WOULDA** $${wouldaStr} ${wouldaLabel}`,
  ];
  if (tx) lines.push(`tx ${tx}`);
  return lines;
}

export function receiptFooter(opts = {}) {
  return receiptLines(opts).join(HARD);
}

/** Same body without markdown, for the X compose box. */
export function xTweetReceipt(opts = {}) {
  return receiptLines(opts)
    .map((line) => line.replace(/\*\*/g, ''))
    .join(HARD);
}

/** What X does when it eats extra blank lines but keeps single \n. */
export function afterXCollapse(text) {
  return String(text).replace(/\n{2,}/g, '\n').trim();
}
