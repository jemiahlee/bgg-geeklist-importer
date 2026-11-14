import fs from "node:fs";

// Simple JSON ledger of what has been posted live, so re-running the importer
// doesn't add the same BGG item to the same geeklist twice.
//
// Shape: { "<geeklistId>": { "<BGG id>": { id, label, postedAt, price, count } } }
// Items whose BGG id couldn't be resolved are keyed by "label:<normalized label>" instead.

export function geeklistId(url) {
  return url.match(/\/geeklist\/(\d+)/)?.[1] ?? url;
}

function normalizeLabel(label) {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

// BGG can list distinct games under the same name and year, so the id is the
// only reliable identity; the label is just a fallback.
function itemKey({ id, label }) {
  return id ? String(id) : `label:${normalizeLabel(label)}`;
}

export function loadHistory(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not parse history file ${file}: ${err.message}. Fix or delete it.`);
  }
}

// `item` is { id, label }; id may be null if it couldn't be resolved.
export function findPosted(history, geeklistUrl, item) {
  return history[geeklistId(geeklistUrl)]?.[itemKey(item)] ?? null;
}

function stripYear(key) {
  return key.replace(/\s*\(\d{4}\)$/, "");
}

// Match a CSV game title against ledger labels ("Nippon" vs "Nippon (2015)")
// without needing the BGG search/disambiguation step first.
export function findPostedByTitle(history, geeklistUrl, title) {
  const want = stripYear(normalizeLabel(title));
  const entries = Object.values(history[geeklistId(geeklistUrl)] ?? {});
  return entries.find((e) => stripYear(normalizeLabel(e.label)) === want) ?? null;
}

// Write-then-rename so a crash mid-write can't corrupt the ledger.
function save(file, history) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(history, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function recordPosted(file, history, geeklistUrl, item, price) {
  const list = (history[geeklistId(geeklistUrl)] ??= {});
  const key = itemKey(item);
  list[key] = {
    id: item.id ? String(item.id) : null,
    label: item.label,
    postedAt: new Date().toISOString(),
    price,
    count: (list[key]?.count ?? 0) + 1,
  };
  save(file, history);
}

// Records a price change on an existing entry, keeping the earlier prices.
// Returns false if the item isn't in the ledger.
export function updatePrice(file, history, geeklistUrl, item, price) {
  const entry = findPosted(history, geeklistUrl, item);
  if (!entry) return false;
  entry.priceHistory = [...(entry.priceHistory ?? []), { price: entry.price, changedAt: new Date().toISOString() }];
  entry.price = price;
  save(file, history);
  return true;
}

export function removePosted(file, history, geeklistUrl, item) {
  const list = history[geeklistId(geeklistUrl)];
  const key = itemKey(item);
  if (!list?.[key]) return false;
  delete list[key];
  save(file, history);
  return true;
}
