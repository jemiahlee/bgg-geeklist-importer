// Price handling for geeklist item bodies. BGG markup strikes text through
// with [-]...[/-].

export const isValidPrice = (value) => /^\d+(\.\d{1,2})?$/.test(value.trim()) && Number(value) > 0;

const PRICE_LINE = /^(Price:[ \t]*)(.*)$/im;
const STRUCK = /\[-\](.*?)\[\/-\]/g;

// Reads the "Price:" line of an item body: prices already struck through, and
// the current (unstruck) one. Returns null if the body has no Price line.
export function parsePriceLine(body) {
  const m = body.match(PRICE_LINE);
  if (!m) return null;
  const rest = m[2];
  const struck = [...rest.matchAll(STRUCK)].map((s) => s[1].trim());
  const current = rest.replace(STRUCK, "").trim();
  const amount = Number.parseFloat(current.replace(/[^0-9.]/g, ""));
  return { line: m[0], struck, current, amount: Number.isNaN(amount) ? null : amount };
}

// Strikes the current price and appends the new one, keeping earlier strikes:
// "Price: $25" -> "Price: [-]$25[/-] $20" -> "Price: [-]$25[/-] [-]$20[/-] $15".
export function applyReprice(body, newPrice) {
  return body.replace(PRICE_LINE, (_, prefix, rest) => {
    const current = rest.replace(STRUCK, "").trim();
    const kept = [...rest.matchAll(STRUCK)].map((s) => `[-]${s[1].trim()}[/-]`);
    return `${prefix}${[...kept, `[-]${current}[/-]`, `$${newPrice.trim()}`].join(" ")}`;
  });
}

// Decides whether an item needs a visit to swap its boilerplate, using what the
// ledger recorded for it (`recorded`) and the optional --old text. `candidates`
// are the texts the item may contain in place of the new one. No visit is made
// when the item is recorded as already having the new text, or when nothing is
// known about what it contains. `recheck` visits regardless of the record.
export function planBoilerplateVisit({ recorded, oldText, newText, recheck = false }) {
  const newB = newText.trim();
  if (!recheck && recorded?.trim() === newB) return { visit: false, reason: "current" };
  const candidates = [...new Set([recorded, oldText].filter(Boolean).map((t) => t.trim()))].filter((t) => t !== newB);
  if (candidates.length === 0 && !recheck) return { visit: false, reason: "unknown" };
  return { visit: true, candidates };
}

// Tries each candidate old text against the body: { status: "replaced", body,
// from }, "already" or "missing" (see replaceBoilerplate).
export function resolveBoilerplate(body, candidates, newText) {
  for (const candidate of candidates) {
    const result = replaceBoilerplate(body, candidate, newText);
    if (result.status !== "missing") return { ...result, from: candidate };
  }
  return { status: body.includes(newText.trim()) ? "already" : "missing" };
}

// Swaps the boilerplate text in an item body for new text. Resolves to
// { status: "replaced", body }, "already" (the new text is there and the old
// isn't, so there's nothing to do) or "missing" (neither is).
export function replaceBoilerplate(body, oldText, newText) {
  const oldB = oldText.trim();
  const newB = newText.trim();
  if (body.includes(newB) && !oldB.includes(newB)) return { status: "already" };
  if (!body.includes(oldB)) return { status: "missing" };
  return { status: "replaced", body: body.split(oldB).join(newB) };
}
