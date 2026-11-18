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
