import { chromium } from "playwright";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { select, confirm, input } from "@inquirer/prompts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STORAGE_STATE_PATH } from "./config.mjs";
import {
  searchBggCandidates,
  matchBggId,
  getBggRecentSales,
  summarizeRecentSales,
  searchBoardGameOracle,
  matchOracleItem,
} from "./pricing.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    csv: path.join(ROOT, "items.csv"),
    boilerplate: path.join(ROOT, "boilerplate.txt"),
    template: path.join(ROOT, "template.txt"),
    geeklist: "https://boardgamegeek.com/geeklist/343300/portland-or-area-virtual-flea-market-v20",
    live: false,
    limit: Infinity,
    delayMs: 4000,
    checkPrices: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--csv") opts.csv = path.resolve(args[++i]);
    else if (a === "--boilerplate") opts.boilerplate = path.resolve(args[++i]);
    else if (a === "--template") opts.template = path.resolve(args[++i]);
    else if (a === "--geeklist") opts.geeklist = args[++i];
    else if (a === "--live") opts.live = true;
    else if (a === "--limit") opts.limit = parseInt(args[++i], 10);
    else if (a === "--delay-ms") opts.delayMs = parseInt(args[++i], 10);
    else if (a === "--check-prices") opts.checkPrices = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

function readOptional(filePath, fallback = "") {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : fallback;
}

const DEFAULT_TEMPLATE = `Condition: {{condition}}
Price: \${{price}}

{{boilerplate}}`;

function renderBody(template, row, boilerplate) {
  return template
    .replaceAll("{{game}}", row.game ?? "")
    .replaceAll("{{price}}", row.price ?? "")
    .replaceAll("{{condition}}", row.condition ?? "")
    .replaceAll("{{boilerplate}}", boilerplate.trim());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkPrice(page, context, row, chosenLabel) {
  console.log(`  Looking up pricing data for "${chosenLabel}"...`);

  const candidates = await searchBggCandidates(page, row.game);
  const matched = matchBggId(candidates, chosenLabel);

  let salesSummary = null;
  if (matched) {
    const sales = await getBggRecentSales(context, matched.id, { limit: 15 });
    salesSummary = summarizeRecentSales(sales, row.condition);
  } else {
    console.log(`  Could not resolve a BGG id for "${chosenLabel}" — skipping recent sales lookup.`);
  }

  const nameYearMatch = chosenLabel.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  let oracleMatch = null;
  if (nameYearMatch) {
    const [, name, year] = nameYearMatch;
    const oracleItems = await searchBoardGameOracle(row.game);
    oracleMatch = matchOracleItem(oracleItems, name.trim(), Number(year));
  }

  console.log(`  --- Pricing for "${chosenLabel}" ---`);
  if (salesSummary?.overall) {
    const { count, min, max, median: med } = salesSummary.overall;
    console.log(`  BGG recent sales (USD, last ${count}): $${min.toFixed(2)}–$${max.toFixed(2)}, median $${med.toFixed(2)}`);
    if (salesSummary.matchedLabel) {
      if (salesSummary.byCondition) {
        const c = salesSummary.byCondition;
        console.log(
          `    "${salesSummary.matchedLabel}" condition (${c.count}): $${c.min.toFixed(2)}–$${c.max.toFixed(2)}, median $${c.median.toFixed(2)}`
        );
      } else {
        console.log(`    No recent "${salesSummary.matchedLabel}" condition sales in this sample.`);
      }
    }
  } else {
    console.log(`  BGG recent sales: no data found.`);
  }
  if (oracleMatch) {
    console.log(
      `  BoardGameOracle lowest new price: $${oracleMatch.lowest_price.price.toFixed(2)} (${oracleMatch.lowest_price.merchantShortName}, ${oracleMatch.prices_count} listing(s))`
    );
  } else {
    console.log(`  BoardGameOracle: no match found.`);
  }

  const suggested = salesSummary?.byCondition?.median ?? salesSummary?.overall?.median ?? row.price;

  return input({
    message: `  Price to use for this listing (CSV had ${row.price})`,
    default: String(suggested),
  });
}

async function main() {
  const opts = parseArgs();

  if (!fs.existsSync(opts.csv)) {
    console.error(`CSV not found: ${opts.csv}`);
    process.exit(1);
  }
  if (!fs.existsSync(STORAGE_STATE_PATH)) {
    console.error(`No saved login session found at ${STORAGE_STATE_PATH}. Run "bun run login" first.`);
    process.exit(1);
  }

  const rows = parse(fs.readFileSync(opts.csv, "utf8"), { columns: true, skip_empty_lines: true, trim: true });
  const boilerplate = readOptional(opts.boilerplate);
  const template = readOptional(opts.template, DEFAULT_TEMPLATE);

  const limited = rows.slice(0, opts.limit);
  console.log(`Loaded ${rows.length} row(s) from ${opts.csv}${opts.limit < rows.length ? `, processing first ${limited.length}` : ""}.`);
  console.log(opts.live ? "Mode: LIVE — items will actually be posted." : "Mode: DRY RUN — items are filled in and then cancelled, nothing is posted. Pass --live to post for real.");

  if (opts.live) {
    const proceed = await confirm({
      message: `This will add ${limited.length} real item(s) to the live geeklist. Continue?`,
      default: false,
    });
    if (!proceed) {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  const browser = await chromium.launch({
    headless: false,
    channel: "chrome",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    storageState: STORAGE_STATE_PATH,
    viewport: { width: 1280, height: 900 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();

  await page.goto(opts.geeklist, { waitUntil: "networkidle" });

  const skipped = [];
  let posted = 0;

  for (const [i, row] of limited.entries()) {
    const label = `[${i + 1}/${limited.length}] ${row.game}`;
    console.log(`\n${label}`);

    const addButtons = await page.$$("button:has-text('Add Item')");
    await addButtons[0].click();

    const searchBox = await page.waitForSelector("input[placeholder='Search or Paste a Link']");
    await searchBox.fill(row.game);

    let options = [];
    try {
      await page.waitForSelector("ngb-typeahead-window button[role='option']", { timeout: 8000 });
      options = await page.$$("ngb-typeahead-window button[role='option']");
    } catch {
      // no matches
    }

    if (options.length === 0) {
      console.log(`  No BGG matches found for "${row.game}". Skipping — add this one manually.`);
      skipped.push({ ...row, reason: "no BGG match found" });
      const cancelBtn = await page.$("button:has-text('Cancel')");
      if (cancelBtn) await cancelBtn.click();
      continue;
    }

    const optionTexts = (await Promise.all(options.map((o) => o.textContent()))).map((t) => t.trim());
    let chosenIndex = 0;
    if (options.length > 1) {
      chosenIndex = await select({
        message: `Multiple BGG matches for "${row.game}" — pick the right one:`,
        choices: [
          ...optionTexts.map((t, idx) => ({ name: t, value: idx })),
          { name: "(skip this row)", value: -1 },
        ],
      });
      if (chosenIndex === -1) {
        console.log(`  Skipped by user.`);
        skipped.push({ ...row, reason: "skipped during disambiguation" });
        const cancelBtn = await page.$("button:has-text('Cancel')");
        if (cancelBtn) await cancelBtn.click();
        continue;
      }
    }
    const chosenLabel = optionTexts[chosenIndex];

    let effectiveRow = row;
    if (opts.checkPrices) {
      effectiveRow = { ...row, price: await checkPrice(page, context, row, chosenLabel) };
    }

    await options[chosenIndex].click();
    const continueBtn = await page.waitForSelector("button:has-text('Continue')");
    await continueBtn.click();

    await page.waitForSelector("gg-geeklist-item-edit-new");
    const textarea = await page.waitForSelector("gg-geeklist-item-edit-new textarea[name='text']");
    const body = renderBody(template, effectiveRow, boilerplate);
    await textarea.fill(body);

    if (opts.live) {
      const saveBtn = await page.$("gg-geeklist-item-edit-new button:has-text('Save')");
      await saveBtn.click();
      await page.waitForSelector("gg-geeklist-item-edit-new", { state: "detached", timeout: 15000 });
      posted++;
      console.log(`  Posted.`);
    } else {
      const screenshotPath = path.join(ROOT, `dry-run-${i + 1}.png`);
      await page.screenshot({ path: screenshotPath });
      console.log(`  Dry run: filled form, screenshot saved to ${screenshotPath}`);
      const cancelBtn = await page.$("gg-geeklist-item-edit-new button:has-text('Cancel')");
      await cancelBtn.click();
      await page.waitForSelector("gg-geeklist-item-edit-new", { state: "detached", timeout: 15000 });
    }

    const jitter = Math.floor(Math.random() * 1500);
    await sleep(opts.delayMs + jitter);
  }

  await browser.close();

  console.log(`\nDone. ${opts.live ? `Posted ${posted} item(s).` : "Dry run complete, nothing was posted."}`);
  if (skipped.length > 0) {
    const skippedPath = path.join(ROOT, "skipped.csv");
    fs.writeFileSync(skippedPath, stringify(skipped, { header: true }));
    console.log(`${skipped.length} row(s) need manual attention — see ${skippedPath}`);
  }
}

main();
