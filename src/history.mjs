import fs from "node:fs";

// Simple JSON ledger of what has been posted live, so re-running the importer
// doesn't add the same BGG item to the same geeklist twice.
//
// Shape: { "<geeklistId>": { "<normalized BGG label>": { label, postedAt, price, count } } }

export function geeklistId(url) {
  return url.match(/\/geeklist\/(\d+)/)?.[1] ?? url;
}

function itemKey(label) {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

export function loadHistory(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not parse history file ${file}: ${err.message}. Fix or delete it.`);
  }
}

export function findPosted(history, geeklistUrl, label) {
  return history[geeklistId(geeklistUrl)]?.[itemKey(label)] ?? null;
}

function stripYear(key) {
  return key.replace(/\s*\(\d{4}\)$/, "");
}

// Match a CSV game title against ledger labels ("Nippon" vs "Nippon (2015)")
// without needing the BGG search/disambiguation step first.
export function findPostedByTitle(history, geeklistUrl, title) {
  const want = stripYear(itemKey(title));
  const entries = Object.values(history[geeklistId(geeklistUrl)] ?? {});
  return entries.find((e) => stripYear(itemKey(e.label)) === want) ?? null;
}

export function recordPosted(file, history, geeklistUrl, label, price) {
  const list = (history[geeklistId(geeklistUrl)] ??= {});
  const key = itemKey(label);
  list[key] = {
    label,
    postedAt: new Date().toISOString(),
    price,
    count: (list[key]?.count ?? 0) + 1,
  };
  // Write-then-rename so a crash mid-write can't corrupt the ledger.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(history, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
