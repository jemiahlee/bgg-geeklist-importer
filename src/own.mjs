import { iterateOwnItems } from "./geeklist.mjs";
import { ledgerItems } from "./history.mjs";

// The user's items on the geeklist, as { itemId, bggId, title }, one at a time.
// By default they come from the ledger, so no page of the geeklist is read; the
// commands check each item when they visit it. `rescan` reads the live list
// instead (page by page, lazily), for items the ledger doesn't know about.
export async function* ownItems(page, history, geeklistUrl, { rescan = false } = {}) {
  if (rescan) {
    yield* iterateOwnItems(page, geeklistUrl);
    return;
  }
  const { items, missingIds } = ledgerItems(history, geeklistUrl);
  if (items.length === 0) {
    throw new Error(
      `The ledger has no item ids for this geeklist${missingIds ? ` (${missingIds} entries predate them)` : ""}. Run "bun run sync-ledger -- --write" to fill them in, or pass --rescan to read the geeklist.`
    );
  }
  if (missingIds > 0) {
    console.warn(`Note: ${missingIds} ledger entr${missingIds === 1 ? "y has" : "ies have"} no item id and will be skipped. Run "bun run sync-ledger -- --write" to fix that.`);
  }
  yield* items;
}

export async function collectOwnItems(page, history, geeklistUrl, options) {
  const items = [];
  for await (const item of ownItems(page, history, geeklistUrl, options)) items.push(item);
  return items;
}
