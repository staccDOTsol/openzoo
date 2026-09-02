// Keyless web search for `openzoo ask --web`: DuckDuckGo's HTML endpoint,
// scraped for title / url / snippet. No API key, no account, one GET. The
// only thing that leaves is the question text, to duckduckgo.com.
const strip = (s) => String(s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();

export async function webSearch(query, max = 5) {
  const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
    headers: { 'user-agent': 'Mozilla/5.0 openzoo-ask/1.0' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`duckduckgo HTTP ${res.status}`);
  const html = await res.text();
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < Math.max(1, Math.min(10, max))) {
    let url = m[1];
    const redirected = url.match(/uddg=([^&]+)/);
    if (redirected) url = decodeURIComponent(redirected[1]);
    out.push({ title: strip(m[2]), url, snippet: strip(m[3]).slice(0, 400) });
  }
  return out;
}

export function formatWebResults(query, hits) {
  const lines = hits.map((h, i) => `${i + 1}. ${h.title} — ${h.url}\n   ${h.snippet}`);
  return `Web search results for "${query}" (DuckDuckGo, fetched just now; cite the url when you rely on one):\n${lines.join('\n')}`;
}
