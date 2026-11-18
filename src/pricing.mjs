import { USER_AGENT } from "./config.mjs";
import { paced } from "./pace.mjs";

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
  const data = await paced(() => page.evaluate(async (searchUrl) => {
    const res = await fetch(searchUrl, {
      headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json, text/plain, */*" },
    });
    return res.ok ? res.json() : null;
  }, url));
  return (data?.items ?? []).map((item) => ({ id: item.id, name: item.name, year: item.yearpublished }));
}

// `label` is the text of the typeahead option the user picked, e.g. "Catan: Cities & Knights (1998)".
// BGG can have several distinct games with the same name and year (two "Flowers (2024)"),
// so `occurrence` picks the nth candidate with that label.
export function matchBggId(candidates, label, occurrence = 0) {
  const m = label.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  if (!m) return null;
  const [, name, year] = m;
  const found = candidates.filter((c) => c.name === name.trim() && String(c.year) === year)[occurrence];
  return found ? { id: found.id, name: found.name, year: found.year } : null;
}

// Resolves every typeahead option label to a BGG id. Options with identical labels
// are paired with identically-labelled candidates in order, since the typeahead and
// the search endpoint list duplicates in the same order.
export function matchBggOptions(candidates, labels) {
  const seen = new Map();
  return labels.map((label) => {
    const occurrence = seen.get(label) ?? 0;
    seen.set(label, occurrence + 1);
    return matchBggId(candidates, label, occurrence);
  });
}

// GeekMarket Price History lists actual sold items (price, condition, sale date),
// newest first — a better pricing signal than active "for sale" listings.
// `page` is a long-lived tab owned by the caller: opening and closing a fresh
// tab per lookup makes Chrome pull its window to the front each time.
export async function getBggRecentSales(page, bggId, { limit = 15 } = {}) {
  await paced(() => page.goto(`https://boardgamegeek.com/market/pricehistory/thing/${bggId}`, { waitUntil: "networkidle" }));
  await page.waitForSelector("table tbody tr", { timeout: 10000 }).catch(() => {});
  const rows = await page.$$eval("table tbody tr", (trs) =>
    trs
      .map((tr) => {
        const cells = tr.querySelectorAll("td");
        if (cells.length < 4) return null; // skips the <th> header row
        return {
          itemId: cells[0]?.textContent.trim().replace(/^#/, "") ?? "",
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

// Noble Knight Games sells new and used games, so its in-stock listings are a
// good comparable for secondhand prices. The site's own /Search page renders
// no results without its Zoovu search widget, so this calls the same Zoovu API
// the widget does (no auth needed). Each result is one in-stock copy, with its
// price and condition exposed as "dataPoints".
export async function searchNobleKnight(query) {
  const url = `https://api.search.zoovu.com/search?projectId=43167&site=43167&device=desktop&limit=50&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) return [];
  let data;
  try {
    data = await res.json();
  } catch {
    return [];
  }
  const products = data.searchResults?.find((r) => r.type === "products");
  return (products?.results ?? []).flat().flatMap((item) => {
    const points = Object.fromEntries((item.dataPoints ?? []).map((p) => [p.key, p.value]));
    const price = Number.parseFloat(points.Price);
    if (Number.isNaN(price) || item.sxCategoryId !== "BOARD_GAME") return [];
    return [
      {
        title: item.name,
        price,
        condition: points.Condition ?? "",
        productType: points["Product Types"] ?? "",
        url: `https://www.nobleknight.com${item.link}`,
      },
    ];
  });
}

function normalizeTitle(s) {
  return s
    .toLowerCase()
    .replaceAll("&", "and")
    .replace(/[:–-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Noble Knight titles are the game's name plus an optional suffix such as
// "(1st Printing)" or "w/Swift Start Pack". Anything else after the name
// ("Catan Junior", "Wingspan Dice Tower") is a different product.
// Returns matching boxed games, cheapest first.
export function matchNobleKnightItems(items, name) {
  const pattern = new RegExp(`^${normalizeTitle(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s*\\(.*\\)|\\s+w/.*)?$`);
  return items
    .filter((i) => i.productType === "Boxed Game" && pattern.test(normalizeTitle(i.title)))
    .sort((a, b) => a.price - b.price);
}
