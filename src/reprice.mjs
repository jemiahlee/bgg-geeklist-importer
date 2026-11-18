import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { confirm } from "@inquirer/prompts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GEEKLIST, requireLogin, launchSession } from "./browser.mjs";
import { scanOwnItems, matchRows, gotoItem, openEditor, cancelEditor, saveEditor, readBody, itemUrl } from "./geeklist.mjs";
import { isValidPrice, parsePriceLine, applyReprice } from "./markup.mjs";
import { loadHistory, updatePrice } from "./history.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    csv: path.join(ROOT, "reprice.csv"),
    history: path.join(ROOT, "posted.json"),
    geeklist: DEFAULT_GEEKLIST,
    live: false,
    delayMs: 4000,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--csv") opts.csv = path.resolve(args[++i]);
    else if (a === "--history") opts.history = path.resolve(args[++i]);
    else if (a === "--geeklist") opts.geeklist = args[++i];
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
  const { browser, context } = await launchSession();
  try {
    const page = await context.newPage();
    console.log("Scanning the geeklist for your items...");
    const own = await scanOwnItems(page, opts.geeklist);
    console.log(`Found ${own.length} of your items.`);

    const { matches, unmatched } = await matchRows(valid, own);
    for (const u of unmatched) skipped.push({ ...u.row, reason: u.reason });

    // Plan: read each item's current body and work out the edit.
    const plan = [];
    for (const { row, item } of matches) {
      const body = await readBody(page, opts.geeklist, item.itemId);
      const price = parsePriceLine(body);
      const label = `${item.title} (item ${item.itemId})`;
      if (!price) {
        skipped.push({ ...row, reason: `${label}: no "Price:" line in the item` });
      } else if (price.amount === null) {
        skipped.push({ ...row, reason: `${label}: could not read the current price "${price.current}"` });
      } else if (Number(row.price) === price.amount) {
        console.log(`  ${label}: already at $${row.price}, nothing to do.`);
      } else if (Number(row.price) > price.amount) {
        skipped.push({ ...row, reason: `${label}: $${row.price} is higher than the current ${price.current}, not a reduction` });
      } else {
        plan.push({ row, item, body, price, newBody: applyReprice(body, row.price) });
      }
    }

    if (plan.length > 0) {
      console.log(`\n${plan.length} item(s) to reprice:`);
      for (const p of plan) {
        console.log(`\n  ${p.item.title} — ${itemUrl(opts.geeklist, p.item.itemId)}`);
        console.log(`    ${p.price.line}`);
        console.log(`    ${p.newBody.match(/^Price:.*$/im)[0]}`);
      }
    }

    let edited = 0;
    if (plan.length > 0 && !opts.live) {
      console.log("\nDry run: nothing was edited.");
    } else if (plan.length > 0) {
      const proceed = await confirm({ message: `\nEdit ${plan.length} live item(s)?`, default: false });
      if (!proceed) {
        console.log("Aborted.");
      } else {
        for (const p of plan) {
          console.log(`\nEditing ${p.item.title}...`);
          const item = await gotoItem(page, opts.geeklist, p.item.itemId);
          const { form, textarea } = await openEditor(item);
          if ((await textarea.inputValue()) !== p.body) {
            console.log(`  The item changed since it was read. Skipping.`);
            skipped.push({ ...p.row, reason: `${p.item.title}: item changed during the run` });
            await cancelEditor(form);
            continue;
          }
          await textarea.fill(p.newBody);
          await saveEditor(form);
          edited++;
          const label = p.item.bggId ? { id: p.item.bggId, label: p.item.title } : { id: null, label: p.item.title };
          updatePrice(opts.history, history, opts.geeklist, label, p.row.price);
          console.log(`  Saved: ${p.newBody.match(/^Price:.*$/im)[0]}`);
          await sleep(opts.delayMs + Math.floor(Math.random() * 1500));
        }
      }
    }

    console.log(`\nDone. ${opts.live ? `Edited ${edited} item(s).` : "Dry run complete."}`);
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
