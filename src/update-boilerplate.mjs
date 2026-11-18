import { stringify } from "csv-stringify/sync";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GEEKLIST, requireLogin, launchSession } from "./browser.mjs";
import { setRequestDelay } from "./pace.mjs";
import { editItemBody, lf, itemUrl } from "./geeklist.mjs";
import { planBoilerplateVisit, resolveBoilerplate } from "./markup.mjs";
import { loadHistory, findByItemId, ledgerItems, setBoilerplate } from "./history.mjs";
import { ownItems } from "./own.mjs";
import { makeApprover, APPROVER_HELP } from "./prompts.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    old: null,
    new: null,
    geeklist: DEFAULT_GEEKLIST,
    history: path.join(ROOT, "posted.json"),
    rescan: false,
    recheck: false,
    live: false,
    limit: Infinity,
    delayMs: 4000,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--old") opts.old = path.resolve(args[++i]);
    else if (a === "--new") opts.new = path.resolve(args[++i]);
    else if (a === "--geeklist") opts.geeklist = args[++i];
    else if (a === "--history") opts.history = path.resolve(args[++i]);
    else if (a === "--rescan") opts.rescan = true;
    else if (a === "--recheck") opts.recheck = true;
    else if (a === "--request-delay-ms") setRequestDelay(parseInt(args[++i], 10));
    else if (a === "--live") opts.live = true;
    else if (a === "--limit") opts.limit = parseInt(args[++i], 10);
    else if (a === "--delay-ms") opts.delayMs = parseInt(args[++i], 10);
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readText(file, flag) {
  if (!file) {
    console.error(`Missing ${flag} <file>. Usage: bun run update-boilerplate -- --new new.txt [--old old.txt] [--live]`);
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }
  const text = lf(fs.readFileSync(file, "utf8")).trim();
  if (!text) {
    console.error(`${file} is empty.`);
    process.exit(1);
  }
  return text;
}

const indent = (text, prefix = "    ") => text.split("\n").map((line) => `${prefix}${line}`).join("\n");

async function main() {
  const opts = parseArgs();
  const newText = readText(opts.new, "--new");
  const oldText = opts.old ? readText(opts.old, "--old") : null;
  if (oldText === newText) {
    console.error("The old and new boilerplate files are identical; nothing to update.");
    process.exit(1);
  }
  requireLogin();
  const history = loadHistory(opts.history);

  // What each item is recorded as containing comes from the ledger, so the old
  // text needn't be kept in a file; --old only covers items with no record.
  const recorded = new Map();
  let unrecorded = 0;
  if (!opts.rescan) {
    for (const { entry } of ledgerItems(history, opts.geeklist).items) {
      if (entry.boilerplate) recorded.set(entry.boilerplate, (recorded.get(entry.boilerplate) ?? 0) + 1);
      else unrecorded++;
    }
  }
  const current = recorded.get(newText) ?? 0;
  recorded.delete(newText);
  for (const [text, count] of recorded) {
    console.log(`Replacing this boilerplate (recorded on ${count} item(s)):\n`);
    console.log(indent(text));
    console.log("");
  }
  if (oldText && !recorded.has(oldText)) {
    console.log(`Replacing this boilerplate (from --old${unrecorded ? `, for the ${unrecorded} item(s) with no record` : ""}):\n`);
    console.log(indent(oldText));
    console.log("");
  }
  console.log("with this:\n");
  console.log(indent(newText));
  if (current) console.log(`\n${current} item(s) are recorded as already having it and won't be visited${opts.recheck ? " (except --recheck)" : ""}.`);
  console.log(opts.live ? "\nMode: LIVE — items will actually be edited." : "\nMode: DRY RUN — nothing is edited. Pass --live to edit for real.");

  const skipped = [];
  const approve = makeApprover();
  let planned = 0;
  let already = 0;
  let edited = 0;
  let unknown = 0;
  const { browser, context } = await launchSession();
  try {
    const page = await context.newPage();
    if (opts.live) console.log(`\n${APPROVER_HELP}`);
    console.log(`\n${opts.rescan ? "Reading the geeklist" : "Using the ledger"} for your items; each one is checked as it is reached.`);

    // Items are handled one at a time, as they are found: read, show the new
    // body (condition, price and all), and in live mode ask and save.
    for await (const item of ownItems(page, history, opts.geeklist, { rescan: opts.rescan })) {
      if (planned >= opts.limit) break;
      const label = `${item.title} (item ${item.itemId})`;
      const entry = item.entry ?? findByItemId(history, opts.geeklist, item.itemId);
      const visit = planBoilerplateVisit({ recorded: entry?.boilerplate, oldText, newText, recheck: opts.recheck });
      if (!visit.visit) {
        if (visit.reason === "current") already++;
        else {
          unknown++;
          skipped.push({ itemId: item.itemId, title: item.title, reason: "boilerplate not recorded for this item; pass --old once" });
        }
        continue;
      }
      const result = await editItemBody(page, opts.geeklist, item, async (rawBody) => {
        const body = lf(rawBody);
        const replaced = resolveBoilerplate(body, visit.candidates, newText);
        if (replaced.status === "already") {
          already++;
          setBoilerplate(opts.history, history, entry, newText);
          console.log(`\n  ${label}: already has the new text.`);
          return null;
        }
        if (replaced.status === "missing") {
          console.log(`\n  ${label}: old boilerplate text not found; skipping.`);
          const wasRecorded = Boolean(entry?.boilerplate);
          skipped.push({ itemId: item.itemId, title: item.title, reason: wasRecorded ? "recorded boilerplate not found in the item (edited by hand?)" : "old boilerplate text not found in the item" });
          setBoilerplate(opts.history, history, entry, null);
          return null;
        }
        planned++;
        // Seen with our own eyes, so worth remembering even on a dry run.
        setBoilerplate(opts.history, history, entry, replaced.from);
        console.log(`\n  ${label} — ${itemUrl(opts.geeklist, item.itemId)}`);
        console.log(indent(replaced.body));
        if (!opts.live) return null;
        if (!(await approve(`Edit ${label}?`))) {
          console.log(`  Skipped.`);
          skipped.push({ itemId: item.itemId, title: item.title, reason: "declined at the prompt" });
          return null;
        }
        return { newBody: replaced.body };
      });
      if (result.status === "saved") {
        edited++;
        setBoilerplate(opts.history, history, entry, newText);
        console.log(`  Saved.`);
        await sleep(opts.delayMs + Math.floor(Math.random() * 1500));
      } else if (result.status === "failed") {
        console.log(`\n  ${label}: ${result.reason}. Skipping.`);
        skipped.push({ itemId: item.itemId, title: item.title, reason: result.reason });
      }
    }

    console.log(
      `\nDone. ${planned} item(s) needed the new text${planned >= opts.limit ? " (stopped at --limit)" : ""}; ${already} already had it; ${skipped.length} skipped${unknown ? ` (${unknown} with no recorded boilerplate; pass --old once to cover them)` : ""}. ` +
        (opts.live ? `Edited ${edited}.` : "Dry run: nothing was edited. Pass --live to edit for real.")
    );
  } finally {
    await browser.close();
  }

  if (skipped.length > 0) {
    const skippedPath = path.join(ROOT, "skipped-boilerplate.csv");
    fs.writeFileSync(skippedPath, stringify(skipped, { header: true }));
    console.log(`${skipped.length} item(s) not updated — see ${skippedPath}`);
  }
}

main();
