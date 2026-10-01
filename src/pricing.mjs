import { USER_AGENT } from "./config.mjs";

const CONDITION_LABELS = ["New", "Like New", "Very Good", "Good", "Acceptable"];

function median(numbers) {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function summarize(prices) {
  if (prices.length === 0) return null;
  return {
    count: prices.length,
    min: Math.min(...prices),
    max: Math.max(...prices),
    median: median(prices),
  };
}

// Mirrors the request BGG's own "Add Item" autocomplete makes (captured from
// the live site). Must run via page.evaluate: a bare fetch() from Node gets a
// 403 from Cloudflare, and without the X-Requested-With header BGG returns the
// full HTML search page instead of JSON.
export async function searchBggCandidates(page, query) {
  const url = `https://boardgamegeek.com/search/boardgame?q=${encodeURIComponent(query)}&nosession=1&showcount=50&singular=1`;
  const data = await page.evaluate(async (searchUrl) => {
    const res = await fetch(searchUrl, {
      headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json, text/plain, */*" },
    });
    return res.ok ? res.json() : null;
  }, url);
  return (data?.items ?? []).map((item) => ({ id: item.id, name: item.name, year: item.yearpublished }));
}

// `label` is the text of the typeahead option the user picked, e.g. "Catan: Cities & Knights (1998)".
export function matchBggId(candidates, label) {
  const m = label.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  if (!m) return null;
  const [, name, year] = m;
  const found = candidates.find((c) => c.name === name.trim() && String(c.year) === year);
  return found ? { id: found.id, name: found.name, year: found.year } : null;
}

// GeekMarket Price History lists actual sold items (price, condition, sale date),
// newest first — a better pricing signal than active "for sale" listings.
export async function getBggRecentSales(context, bggId, { limit = 15 } = {}) {
  const page = await context.newPage();
  try {
    await page.goto(`https://boardgamegeek.com/market/pricehistory/thing/${bggId}`, { waitUntil: "networkidle" });
    await page.waitForSelector("table tbody tr", { timeout: 10000 }).catch(() => {});
    const rows = await page.$$eval("table tbody tr", (trs) =>
      trs
        .map((tr) => {
          const cells = tr.querySelectorAll("td");
          if (cells.length < 4) return null; // skips the <th> header row
          return {
            price: cells[1]?.textContent.trim() ?? "",
            condition: cells[2]?.textContent.trim() ?? "",
            date: cells[3]?.textContent.trim() ?? "",
          };
        })
        .filter(Boolean)
    );
    return rows
      .filter((r) => r.price.startsWith("$"))
      .slice(0, limit)
      .map((r) => ({ ...r, price: Number.parseFloat(r.price.replace(/[^0-9.]/g, "")) }));
  } finally {
    await page.close();
  }
}

export function summarizeRecentSales(sales, conditionHint) {
  const overall = summarize(sales.map((s) => s.price));
  const matchedLabel = CONDITION_LABELS.find((label) => conditionHint?.toLowerCase().includes(label.toLowerCase()));
  const byCondition = matchedLabel
    ? summarize(sales.filter((s) => s.condition === matchedLabel).map((s) => s.price))
    : null;
  return { overall, matchedLabel, byCondition };
}

// BoardGameOracle aggregates new/retail prices (not secondhand), useful as a
// reference ceiling. It's a Next.js app with no public write API; the search
// results page embeds the data as JSON in a __NEXT_DATA__ script tag, which is
// far more reliable to parse than the rendered HTML.
export async function searchBoardGameOracle(query) {
  const url = `https://www.boardgameoracle.com/boardgame/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) return [];
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!m) return [];
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return [];
  }
  const queries = data.props?.pageProps?.trpcState?.queries ?? {};
  const listQuery = Object.values(queries).find((q) => q.queryKey?.[0]?.join(".") === "boardgame.list");
  return listQuery?.state?.data?.pages?.flatMap((p) => p.items) ?? [];
}

export function matchOracleItem(items, name, year) {
  const lowerName = name.toLowerCase();
  return (
    items.find((i) => i.title.toLowerCase() === lowerName && i.year_published === year) ??
    items.find((i) => i.title.toLowerCase() === lowerName) ??
    null
  );
}
