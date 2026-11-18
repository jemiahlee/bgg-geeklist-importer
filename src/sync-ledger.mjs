import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GEEKLIST, requireLogin, launchSession } from "./browser.mjs";
import { setRequestDelay } from "./pace.mjs";
import { scanOwnItems, itemUrl } from "./geeklist.mjs";
import { loadHistory, planSync, applySync } from "./history.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { history: path.join(ROOT, "posted.json"), geeklist: DEFAULT_GEEKLIST, write: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--history") opts.history = path.resolve(args[++i]);
    else if (a === "--geeklist") opts.geeklist = args[++i];
    else if (a === "--request-delay-ms") setRequestDelay(parseInt(args[++i], 10));
    else if (a === "--write") opts.write = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

// Reconciles posted.json with the geeklist: records the geeklist item id of every
// entry that lacks one, and adds items of yours the ledger has never seen. It only
// ever writes the local ledger; nothing on BGG is changed.
async function main() {
  const opts = parseArgs();
  requireLogin();
  console.log(opts.write ? "Mode: WRITE — posted.json will be updated." : "Mode: DRY RUN — posted.json is not changed. Pass --write to update it.");

  const history = loadHistory(opts.history);
  const { browser, context } = await launchSession();
  let own;
  try {
    const page = await context.newPage();
    console.log("\nReading the whole geeklist for your items (this is the one full scan)...");
    own = await scanOwnItems(page, opts.geeklist);
  } finally {
    await browser.close();
  }
  console.log(`Found ${own.length} of your items.`);

  const plan = planSync(history, opts.geeklist, own);
  console.log(`\n${plan.assign.length} ledger entr${plan.assign.length === 1 ? "y" : "ies"} matched to an item and given its item id.`);
  console.log(`${plan.add.length} item(s) on the list that the ledger didn't have${plan.add.length ? " (will be added, without price or post date):" : "."}`);
  for (const item of plan.add) console.log(`  ${item.title} — ${itemUrl(opts.geeklist, item.itemId)}`);
  console.log(`${plan.orphans.length} ledger entr${plan.orphans.length === 1 ? "y" : "ies"} with no matching item on the list (left in the ledger):`);
  for (const e of plan.orphans) console.log(`  ${e.label}${e.itemId ? ` (item ${e.itemId})` : ""}`);

  if (opts.write) {
    applySync(opts.history, history, opts.geeklist, plan);
    console.log(`\nWrote ${opts.history}.`);
  } else {
    console.log("\nDry run: posted.json was not changed.");
  }
}

main();
