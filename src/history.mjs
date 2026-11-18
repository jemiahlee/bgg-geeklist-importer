import fs from "node:fs";

// Simple JSON ledger of what has been posted live, so re-running the importer
// doesn't add the same BGG item to the same geeklist twice.
//
// Shape: { "<geeklistId>": { "<geeklist item id>": { itemId, id, label, postedAt, price } } }
// `itemId` is the item's own id on the geeklist (the ?itemid= in its URL), which is
// what lets the other commands go straight to an item without scanning the list;
// `id` is the BGG game id. The same game can be listed twice, as two entries.
// Entries from before item ids were recorded are keyed by BGG id (or
// "label:<normalized label>") and have no itemId until `sync-ledger` fills it in.

export function geeklistId(url) {
  return url.match(/\/geeklist\/(\d+)/)?.[1] ?? url;
}

function normalizeLabel(label) {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

// BGG can list distinct games under the same name and year, so the id is the
// only reliable identity; the label is just a fallback.
function sameGame(entry, { id, label }) {
  return id ? entry.id === String(id) : !entry.id && normalizeLabel(entry.label) === normalizeLabel(label);
}

function entriesOf(history, geeklistUrl) {
  return history[geeklistId(geeklistUrl)] ?? {};
}

export function loadHistory(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not parse history file ${file}: ${err.message}. Fix or delete it.`);
  }
}

// `item` is { id, label }; id may be null if it couldn't be resolved. If the
// game is listed more than once, the earliest entry is returned.
export function findPosted(history, geeklistUrl, item) {
  return Object.values(entriesOf(history, geeklistUrl)).find((e) => sameGame(e, item)) ?? null;
}

function stripYear(key) {
  return key.replace(/\s*\(\d{4}\)$/, "");
}

// Match a CSV game title against ledger labels ("Nippon" vs "Nippon (2015)")
// without needing the BGG search/disambiguation step first.
export function findPostedByTitle(history, geeklistUrl, title) {
  const want = stripYear(normalizeLabel(title));
  const entries = Object.values(entriesOf(history, geeklistUrl));
  return entries.find((e) => stripYear(normalizeLabel(e.label)) === want) ?? null;
}

// Write-then-rename so a crash mid-write can't corrupt the ledger.
function save(file, history) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(history, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// Records a new post and returns its entry. `item.itemId` may be unknown right
// after posting; the entry is then keyed provisionally until `setItemId`.
export function recordPosted(file, history, geeklistUrl, item, price) {
  const list = (history[geeklistId(geeklistUrl)] ??= {});
  const entry = {
    itemId: item.itemId ? String(item.itemId) : null,
    id: item.id ? String(item.id) : null,
    label: item.label,
    postedAt: new Date().toISOString(),
    price,
  };
  list[entry.itemId ?? `pending:${Date.now()}:${entry.id ?? normalizeLabel(entry.label)}`] = entry;
  save(file, history);
  return entry;
}

// Gives an entry its geeklist item id, re-keying it under that id.
export function setItemId(file, history, geeklistUrl, entry, itemId) {
  const list = history[geeklistId(geeklistUrl)];
  const key = Object.keys(list ?? {}).find((k) => list[k] === entry);
  if (key === undefined) return false;
  delete list[key];
  entry.itemId = String(itemId);
  list[entry.itemId] = entry;
  save(file, history);
  return true;
}

// The [key, entry] for `item`: by geeklist item id if it has one, else (for
// entries that predate item ids) by game.
function locate(history, geeklistUrl, item) {
  const list = entriesOf(history, geeklistUrl);
  if (item.itemId && list[item.itemId]) return [item.itemId, list[item.itemId]];
  const found = Object.entries(list).find(([, e]) => !e.itemId && sameGame(e, item));
  return found ?? [null, null];
}

// Records a price change on an existing entry, keeping the earlier prices.
// Returns false if the item isn't in the ledger.
export function updatePrice(file, history, geeklistUrl, item, price) {
  const [, entry] = locate(history, geeklistUrl, item);
  if (!entry) return false;
  entry.priceHistory = [...(entry.priceHistory ?? []), { price: entry.price, changedAt: new Date().toISOString() }];
  entry.price = price;
  save(file, history);
  return true;
}

export function removePosted(file, history, geeklistUrl, item) {
  const [key] = locate(history, geeklistUrl, item);
  if (key === null) return false;
  delete history[geeklistId(geeklistUrl)][key];
  save(file, history);
  return true;
}

const byItemId = (a, b) => Number(a.itemId) - Number(b.itemId);

// The geeklist items the ledger knows about, in list order, shaped like the
// items `scanOwnItems` returns. `missingIds` counts entries that can't be used
// yet because they predate item ids (see `sync-ledger`).
export function ledgerItems(history, geeklistUrl) {
  const entries = Object.values(entriesOf(history, geeklistUrl));
  const items = entries
    .filter((e) => e.itemId)
    .map((e) => ({ itemId: e.itemId, bggId: e.id, title: e.label, entry: e }))
    .sort(byItemId);
  return { items, missingIds: entries.length - items.length };
}

// Works out how to reconcile the ledger with the user's items as scanned from
// the geeklist (`own`: { itemId, bggId, title }):
//   assign  - legacy entries (no itemId) paired with a listed item
//   add     - listed items the ledger has never seen
//   orphans - entries whose item isn't on the list any more
export function planSync(history, geeklistUrl, own) {
  const entries = Object.values(entriesOf(history, geeklistUrl));
  const onList = new Set(own.map((i) => i.itemId));
  const known = new Set(entries.filter((e) => e.itemId).map((e) => e.itemId));
  const legacy = entries.filter((e) => !e.itemId);
  const claimed = new Set();
  const assign = [];
  const add = [];
  for (const item of own) {
    if (known.has(item.itemId)) continue;
    const free = legacy.filter((e) => !claimed.has(e));
    // Entries whose BGG id was never resolved can only be paired by title.
    const entry =
      free.find((e) => sameGame(e, { id: item.bggId, label: item.title })) ??
      free.find((e) => !e.id && stripYear(normalizeLabel(e.label)) === stripYear(normalizeLabel(item.title)));
    if (entry) {
      claimed.add(entry);
      assign.push({ entry, item });
    } else {
      add.push(item);
    }
  }
  const orphans = entries.filter((e) => (e.itemId ? !onList.has(e.itemId) : !claimed.has(e)));
  return { assign, add, orphans };
}

export function applySync(file, history, geeklistUrl, { assign, add }) {
  const list = (history[geeklistId(geeklistUrl)] ??= {});
  for (const { entry, item } of assign) {
    for (const key of Object.keys(list)) if (list[key] === entry) delete list[key];
    entry.itemId = item.itemId;
    list[item.itemId] = entry;
  }
  for (const item of add) {
    list[item.itemId] = { itemId: item.itemId, id: item.bggId, label: item.title, postedAt: null, price: null };
  }
  save(file, history);
}
