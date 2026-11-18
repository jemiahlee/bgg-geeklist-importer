import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { confirm } from "@inquirer/prompts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GEEKLIST, requireLogin, launchSession } from "./browser.mjs";
import { setRequestDelay } from "./pace.mjs";
import { matchRows, gotoItem, readItemInfo, actionButton, itemUrl } from "./geeklist.mjs";
import { loadHistory, removePosted } from "./history.mjs";
import { collectOwnItems } from "./own.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    csv: path.join(ROOT, "delete.csv"),
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
    else if (a === "--request-delay-ms") setRequestDelay(parseInt(args[++i], 10));
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

// Clicks the item's own Delete button and confirms BGG's follow-up dialog, if
// any. Throws if the item is still there afterwards, so a failed or unexpected
// dialog stops the run instead of carrying on blind.
async function deleteItem(page, item, itemId) {
  const button = await actionButton(item, "Delete");

  page.once("dialog", (dialog) => dialog.accept());
  await button.click();

  const dialogs = page.locator("ngb-modal-window:visible, [role='dialog']:visible");
  const gone = page.locator(`a#item${itemId}`).waitFor({ state: "detached", timeout: 4000 }).then(() => "gone");
  const dialog = dialogs.first().waitFor({ state: "visible", timeout: 4000 }).then(() => "dialog");
  const outcome = await Promise.any([gone, dialog]).catch(() => null);
  if (outcome === "dialog") {
    const buttons = dialogs.first().locator("button");
    const confirmButton = buttons.filter({ hasText: /^\s*(Delete|Yes|OK|Confirm)\b/i });
    if ((await confirmButton.count()) !== 1) {
      const labels = (await buttons.allTextContents()).map((l) => l.trim());
      throw new Error(`Unrecognised delete confirmation dialog (buttons: ${labels.join(" | ")}).`);
    }
    await confirmButton.click();
  }

  await page.locator(`a#item${itemId}`).waitFor({ state: "detached", timeout: 15000 }).catch(() => {
    throw new Error(`Item ${itemId} is still on the page after deleting.`);
  });
}

async function main() {
  const opts = parseArgs();
  if (!fs.existsSync(opts.csv)) {
    console.error(`CSV not found: ${opts.csv}`);
    process.exit(1);
  }
  requireLogin();

  const rows = parse(fs.readFileSync(opts.csv, "utf8"), { columns: true, skip_empty_lines: true, trim: true });
  console.log(`Loaded ${rows.length} row(s) from ${opts.csv}.`);
  console.log(opts.live ? "Mode: LIVE — items will be permanently deleted." : "Mode: DRY RUN — nothing is deleted. Pass --live to delete for real.");

  const history = loadHistory(opts.history);
  const skipped = [];
  const { browser, context } = await launchSession();
  try {
    const page = await context.newPage();
    if (opts.rescan) console.log("Reading the geeklist for your items...");
    const own = await collectOwnItems(page, history, opts.geeklist, { rescan: opts.rescan });
    console.log(`${own.length} of your items to match against.`);

    const { matches, unmatched } = await matchRows(rows, own);
    for (const u of unmatched) skipped.push({ ...u.row, reason: u.reason });

    if (matches.length > 0) {
      console.log(`\n${matches.length} item(s) to delete (each is checked against the live item before anything happens):`);
      for (const { item } of matches) {
        const price = item.entry?.price;
        console.log(`  ${item.title}${price ? ` [listed at $${price}]` : ""}\n    ${itemUrl(opts.geeklist, item.itemId)}`);
      }
    }

    let deleted = 0;
    let proceed = false;
    if (matches.length > 0 && opts.live) {
      proceed = await confirm({
        message: `\nPermanently delete up to ${matches.length} item(s)? This cannot be undone.`,
        default: false,
      });
      if (!proceed) console.log("Aborted.");
    }
    // Each item is visited and compared with what we expect before it is touched.
    for (const { row, item } of proceed || !opts.live ? matches : []) {
      let live;
      try {
        live = await gotoItem(page, opts.geeklist, item.itemId);
      } catch {
        console.log(`\n${item.title}: item ${item.itemId} isn't on the geeklist. Skipping.`);
        skipped.push({ ...row, reason: `${item.title}: item ${item.itemId} not found on the geeklist` });
        continue;
      }
      const info = await readItemInfo(live);
      if (!info.own) {
        console.log(`\n${item.title}: item ${item.itemId} isn't yours. Skipping.`);
        skipped.push({ ...row, reason: `${item.title}: item ${item.itemId} is not yours` });
        continue;
      }
      if (item.bggId && info.bggId && info.bggId !== String(item.bggId)) {
        console.log(`\n${item.title}: item ${item.itemId} is "${info.title}", not the game recorded. Skipping.`);
        skipped.push({ ...row, reason: `${item.title}: item ${item.itemId} is "${info.title}" (BGG ${info.bggId}), not ${item.bggId} as recorded` });
        continue;
      }
      if (!opts.live) {
        console.log(`\n${item.title}: found${info.comments > 0 ? `, HAS ${info.comments} COMMENT(S)` : ""}. Would delete.`);
        continue;
      }
      if (info.comments > 0) {
        const ok = await confirm({ message: `\n${item.title} has ${info.comments} comment(s). Delete it anyway?`, default: false });
        if (!ok) {
          skipped.push({ ...row, reason: `${item.title}: has comments, declined at the prompt` });
          continue;
        }
      }
      console.log(`\nDeleting ${item.title}...`);
      try {
        await deleteItem(page, live, item.itemId);
      } catch (err) {
        console.error(`  Stopping: ${err.message}`);
        skipped.push({ ...row, reason: `${item.title}: ${err.message}` });
        break;
      }
      deleted++;
      removePosted(opts.history, history, opts.geeklist, { itemId: item.itemId, id: item.bggId, label: item.title });
      console.log(`  Deleted.`);
      await sleep(opts.delayMs + Math.floor(Math.random() * 1500));
    }

    if (matches.length > 0 && !opts.live) console.log("\nDry run: nothing was deleted.");
    console.log(`\nDone. ${opts.live ? `Deleted ${deleted} item(s).` : "Dry run complete."}`);
  } finally {
    await browser.close();
  }

  if (skipped.length > 0) {
    const skippedPath = path.join(ROOT, "skipped-delete.csv");
    fs.writeFileSync(skippedPath, stringify(skipped, { header: true }));
    console.log(`${skipped.length} row(s) need attention — see ${skippedPath}`);
  }
}

main();
