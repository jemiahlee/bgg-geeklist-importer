import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GEEKLIST, requireLogin, launchSession } from "./browser.mjs";
import { matchRows, editItemBody, itemUrl } from "./geeklist.mjs";
import { isValidPrice, parsePriceLine, applyReprice } from "./markup.mjs";
import { loadHistory, updatePrice } from "./history.mjs";
import { collectOwnItems } from "./own.mjs";
import { makeApprover, APPROVER_HELP } from "./prompts.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    csv: path.join(ROOT, "reprice.csv"),
    history: path.join(ROOT, "posted.json"),
    geeklist: DEFAULT_GEEKLIST,
    rescan: false,
    live: false,
    delayMs: 4000,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--csv") opts.csv = path.resolve(args[++i]);
    else if (a === "--history") opts.history = path.resolve(args[++i]);
    else if (a === "--geeklist") opts.geeklist = args[++i];
    else if (a === "--rescan") opts.rescan = true;
    else if (a === "--live") opts.live = true;
    else if (a === "--delay-ms") opts.delayMs = parseInt(args[++i], 10);
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const opts = parseArgs();
  if (!fs.existsSync(opts.csv)) {
    console.error(`CSV not found: ${opts.csv}`);
    process.exit(1);
  }
  requireLogin();

  const rows = parse(fs.readFileSync(opts.csv, "utf8"), { columns: true, skip_empty_lines: true, trim: true });
  const skipped = [];
  const valid = rows.filter((row) => {
    if (isValidPrice(row.price ?? "")) return true;
    skipped.push({ ...row, reason: `invalid price "${row.price ?? ""}" (use a number such as 20 or 19.99)` });
    return false;
  });
  console.log(`Loaded ${rows.length} row(s) from ${opts.csv}.`);
  console.log(opts.live ? "Mode: LIVE — items will actually be edited." : "Mode: DRY RUN — nothing is edited. Pass --live to edit for real.");

  const history = loadHistory(opts.history);
  const approve = makeApprover();
  let edited = 0;
  const { browser, context } = await launchSession();
  try {
    const page = await context.newPage();
    if (opts.rescan) console.log("Reading the geeklist for your items...");
    const own = await collectOwnItems(page, history, opts.geeklist, { rescan: opts.rescan });
    console.log(`${own.length} of your items to match against.`);

    const { matches, unmatched } = await matchRows(valid, own);
    for (const u of unmatched) skipped.push({ ...u.row, reason: u.reason });
    if (opts.live && matches.length > 0) console.log(`\n${APPROVER_HELP}`);

    // One item at a time: read its current price, show the change, and in live
    // mode ask and save, all within the same visit to the item.
    for (const { row, item } of matches) {
      const label = `${item.title} (item ${item.itemId})`;
      let newPriceLine;
      const result = await editItemBody(page, opts.geeklist, item, async (body) => {
        const price = parsePriceLine(body);
        if (!price) {
          skipped.push({ ...row, reason: `${label}: no "Price:" line in the item` });
        } else if (price.amount === null) {
          skipped.push({ ...row, reason: `${label}: could not read the current price "${price.current}"` });
        } else if (Number(row.price) === price.amount) {
          console.log(`\n  ${label}: already at $${row.price}, nothing to do.`);
        } else if (Number(row.price) > price.amount) {
          skipped.push({ ...row, reason: `${label}: $${row.price} is higher than the current ${price.current}, not a reduction` });
        } else {
          const newBody = applyReprice(body, row.price);
          newPriceLine = newBody.match(/^Price:.*$/im)[0];
          console.log(`\n  ${item.title} — ${itemUrl(opts.geeklist, item.itemId)}\n    ${price.line}\n    ${newPriceLine}`);
          if (!opts.live) return null;
          if (await approve(`Reprice ${label}?`)) return { newBody };
          skipped.push({ ...row, reason: `${label}: declined at the prompt` });
        }
        return null;
      });
      if (result.status === "saved") {
        edited++;
        updatePrice(opts.history, history, opts.geeklist, { itemId: item.itemId, id: item.bggId, label: item.title }, row.price);
        console.log(`  Saved: ${newPriceLine}`);
        await sleep(opts.delayMs + Math.floor(Math.random() * 1500));
      } else if (result.status === "failed") {
        console.log(`\n  ${label}: ${result.reason}. Skipping.`);
        skipped.push({ ...row, reason: `${label}: ${result.reason}` });
      }
    }

    console.log(`\nDone. ${opts.live ? `Edited ${edited} item(s).` : "Dry run: nothing was edited. Pass --live to edit for real."}`);
  } finally {
    await browser.close();
  }

  if (skipped.length > 0) {
    const skippedPath = path.join(ROOT, "skipped-reprice.csv");
    fs.writeFileSync(skippedPath, stringify(skipped, { header: true }));
    console.log(`${skipped.length} row(s) need attention — see ${skippedPath}`);
  }
}

main();
