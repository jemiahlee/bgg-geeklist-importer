import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { select, confirm, input } from "@inquirer/prompts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GEEKLIST, requireLogin, launchSession } from "./browser.mjs";
import { isValidPrice } from "./markup.mjs";
import {
  searchBggCandidates,
  matchBggOptions,
  getBggRecentSales,
  summarizeRecentSales,
  searchBoardGameOracle,
  matchOracleItem,
  searchNobleKnight,
  matchNobleKnightItems,
} from "./pricing.mjs";
import { loadHistory, findPosted, findPostedByTitle, recordPosted } from "./history.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    csv: path.join(ROOT, "items.csv"),
    boilerplate: path.join(ROOT, "boilerplate.txt"),
    template: path.join(ROOT, "template.txt"),
    history: path.join(ROOT, "posted.json"),
    geeklist: DEFAULT_GEEKLIST,
    live: false,
    limit: Infinity,
    delayMs: 4000,
    checkPrices: true,
    skipPosted: false,
    interactive: false,
    csvGiven: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--csv") {
      opts.csv = path.resolve(args[++i]);
      opts.csvGiven = true;
    } else if (a === "--interactive" || a === "-i") opts.interactive = true;
    else if (a === "--boilerplate") opts.boilerplate = path.resolve(args[++i]);
    else if (a === "--template") opts.template = path.resolve(args[++i]);
    else if (a === "--history") opts.history = path.resolve(args[++i]);
    else if (a === "--geeklist") opts.geeklist = args[++i];
    else if (a === "--live") opts.live = true;
    else if (a === "--limit") opts.limit = parseInt(args[++i], 10);
    else if (a === "--delay-ms") opts.delayMs = parseInt(args[++i], 10);
    else if (a === "--skip-posted") opts.skipPosted = true;
    else if (a === "--no-check-prices") opts.checkPrices = false;
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
  // Drop lines that exist only to label the condition ("Condition: {{condition}}")
  // when the CSV has none, rather than posting a bare "Condition:".
  const body = row.condition?.trim()
    ? template
    : template
        .split("\n")
        .filter((line) => !line.includes("{{condition}}"))
        .join("\n");
  return body
    .replaceAll("{{game}}", row.game ?? "")
    .replaceAll("{{price}}", row.price ?? "")
    .replaceAll("{{condition}}", row.condition ?? "")
    .replaceAll("{{boilerplate}}", boilerplate.trim());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SKIP = Symbol("skip");

// When recent sales span more than this many dollars, the median alone is
// misleading, so the individual newest sales are listed too.
const WIDE_RANGE = 30;
const WIDE_RANGE_SAMPLE = 5;

const isSkip = (value) => value.trim().toLowerCase() === "skip";

// `matched` is the BGG match already resolved for the chosen option, or null.
// Resolves to the price to use, or SKIP if the user chose to skip the item.
async function checkPrice(pricePage, query, row, chosenLabel, matched) {
  console.log(`  Looking up pricing data for "${chosenLabel}"...`);
  if (matched) {
    console.log(`  BGG price history: https://boardgamegeek.com/market/pricehistory/thing/${matched.id}`);
  }

  let salesSummary = null;
  let sales = [];
  if (matched) {
    sales = await getBggRecentSales(pricePage, matched.id, { limit: 15 });
    salesSummary = summarizeRecentSales(sales, row.condition);
  } else {
    console.log(`  Could not resolve a BGG id for "${chosenLabel}" — skipping recent sales lookup.`);
  }

  const nameYearMatch = chosenLabel.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  let oracleMatch = null;
  let nobleKnightMatches = [];
  if (nameYearMatch) {
    const [, name, year] = nameYearMatch;
    const oracleItems = await searchBoardGameOracle(query);
    oracleMatch = matchOracleItem(oracleItems, name.trim(), Number(year));
    const nobleKnightItems = await searchNobleKnight(name.trim());
    nobleKnightMatches = matchNobleKnightItems(nobleKnightItems, name.trim());
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
    if (max - min > WIDE_RANGE) {
      console.log(`    Wide range (over $${WIDE_RANGE}); the ${WIDE_RANGE_SAMPLE} most recent USD sales:`);
      for (const sale of sales.slice(0, WIDE_RANGE_SAMPLE)) {
        console.log(
          `      $${sale.price.toFixed(2)} ${sale.condition}, ${sale.date} — https://boardgamegeek.com/market/saleitem/${sale.itemId}`
        );
      }
    }
  } else {
    console.log(`  BGG recent sales: no data found.`);
  }
  if (oracleMatch?.lowest_price) {
    console.log(
      `  BoardGameOracle lowest new price: $${oracleMatch.lowest_price.price.toFixed(2)} (${oracleMatch.lowest_price.merchantShortName}, ${oracleMatch.prices_count} listing(s))`
    );
  } else if (oracleMatch) {
    console.log(`  BoardGameOracle: matched, but no current new-copy listings.`);
  } else {
    console.log(`  BoardGameOracle: no match found.`);
  }
  if (nobleKnightMatches.length > 0) {
    console.log(`  Noble Knight Games in-stock listings (${nobleKnightMatches.length}), cheapest first:`);
    for (const item of nobleKnightMatches.slice(0, 3)) {
      console.log(`    $${item.price.toFixed(2)} ${item.condition} — ${item.title}`);
    }
  } else {
    console.log(`  Noble Knight Games: no match found.`);
  }

  const suggested = salesSummary?.byCondition?.median ?? salesSummary?.overall?.median ?? row.price;

  return askPrice(`  Price to use for this listing (CSV had ${row.price || "no price"}; type "skip" to skip this item)`, suggested);
}

// Resolves to the price entered, or SKIP if the user typed "skip".
async function askPrice(message, suggested) {
  const answer = await input({
    message,
    default: suggested ? String(suggested) : undefined,
    validate: (value) => isSkip(value) || isValidPrice(value) || 'Enter a number such as 25 or 24.99 (no "$"), or "skip".',
  });
  return isSkip(answer) ? SKIP : answer.trim();
}

// Returns true if the item should be skipped. Prompts unless --skip-posted
// (or an earlier "skip all" answer) is in effect.
async function shouldSkipPosted(opts, prior) {
  if (opts.skipPosted) return true;
  const action = await select({
    message: `"${prior.label}" was already posted to this geeklist on ${prior.postedAt.slice(0, 10)}${prior.price ? ` at $${prior.price}` : ""}.`,
    choices: [
      { name: "Skip it", value: "skip" },
      { name: "Skip it and all other previously posted items this run", value: "skip-all" },
      { name: "Post it again", value: "post" },
    ],
  });
  if (action === "skip-all") opts.skipPosted = true;
  return action !== "post";
}

// The form renders with "subscribe" unchecked, then the page checks it by
// default a moment later. Clicking in that gap gets undone by the page, which
// makes Playwright's .check() fail, so give the default time to land and only
// click if the box is still unchecked afterwards.
async function ensureSubscribed(page, checkbox) {
  for (let waited = 0; waited < 3000; waited += 100) {
    if (await checkbox.isChecked()) return;
    await page.waitForTimeout(100);
  }
  await checkbox.check();
}

async function cancelAdd(page) {
  const cancelBtn = await page.$("button:has-text('Cancel')");
  if (cancelBtn) await cancelBtn.click();
}

// Adds one item to the geeklist. `ctx` holds the shared run state (options,
// pages, ledger, template, and the skipped/posted tallies). Resolves to
// "posted", "dry-run" or "skipped"; skips that need manual follow-up are also
// pushed onto ctx.skipped.
async function processRow(ctx, row, shotNumber) {
  const { opts, page, pricePage, history, template, boilerplate, skipped } = ctx;

  // Check the ledger by title before searching BGG, so already-posted games
  // don't trigger the disambiguation prompt.
  let repostConfirmed = false;
  const priorByTitle = findPostedByTitle(history, opts.geeklist, row.game);
  if (priorByTitle) {
    if (await shouldSkipPosted(opts, priorByTitle)) {
      console.log(`  Skipped: already posted as "${priorByTitle.label}".`);
      return "skipped";
    }
    repostConfirmed = true;
  }

  const addButtons = await page.$$("button:has-text('Add Item')");
  await addButtons[0].click();

  const searchBox = await page.waitForSelector("input[placeholder='Search or Paste a Link']");
  // If nothing matches, offer a different search term (e.g. a BGG title that
  // differs from the CSV name) before giving up on the row.
  let query = row.game;
  let options = [];
  while (true) {
    await searchBox.fill(query);
    try {
      await page.waitForSelector("ngb-typeahead-window button[role='option']", { timeout: 8000 });
      options = await page.$$("ngb-typeahead-window button[role='option']");
    } catch {
      // no matches
    }
    if (options.length > 0) break;
    const next = await input({
      message: `  No BGG matches found for "${query}". Enter a different name to search (blank to skip):`,
    });
    if (!next.trim()) break;
    query = next.trim();
  }

  if (options.length === 0) {
    console.log(`  Skipping — add this one manually.`);
    skipped.push({ ...row, reason: "no BGG match found" });
    await cancelAdd(page);
    return "skipped";
  }

  const optionTexts = (await Promise.all(options.map((o) => o.textContent()))).map((t) => t.trim());
  // Resolve BGG ids up front: they identify the item in the ledger and drive pricing.
  const matches = matchBggOptions(await searchBggCandidates(page, query), optionTexts);
  let chosenIndex = 0;
  if (options.length > 1) {
    console.log(`  Matches for "${query}":`);
    optionTexts.forEach((t, idx) => {
      const id = matches[idx]?.id;
      console.log(`    ${t}${id ? ` — https://boardgamegeek.com/boardgame/${id}` : ""}`);
    });
    chosenIndex = await select({
      message: `Multiple BGG matches for "${query}" — pick the right one:`,
      choices: [
        ...optionTexts.map((t, idx) => ({ name: t, value: idx })),
        { name: "(skip this row)", value: -1 },
      ],
    });
    if (chosenIndex === -1) {
      console.log(`  Skipped by user.`);
      skipped.push({ ...row, reason: "skipped during disambiguation" });
      await cancelAdd(page);
      return "skipped";
    }
  }
  const chosenLabel = optionTexts[chosenIndex];

  const chosen = { id: matches[chosenIndex]?.id ?? null, label: chosenLabel };
  const prior = findPosted(history, opts.geeklist, chosen);
  if (prior && !repostConfirmed && (await shouldSkipPosted(opts, prior))) {
    console.log(`  Skipped: already posted.`);
    await cancelAdd(page);
    return "skipped";
  }

  let effectiveRow = row;
  let price = null;
  if (opts.checkPrices) {
    price = await checkPrice(pricePage, query, row, chosenLabel, matches[chosenIndex]);
  } else if (opts.interactive && !row.price) {
    // No CSV to supply a price, and no lookup to suggest one.
    price = await askPrice(`  Price for "${chosenLabel}" (type "skip" to skip this item)`);
  }
  if (price === SKIP) {
    console.log(`  Skipped by user.`);
    skipped.push({ ...row, reason: "skipped at price prompt" });
    await cancelAdd(page);
    return "skipped";
  }
  if (price !== null) effectiveRow = { ...row, price };

  await options[chosenIndex].click();
  const continueBtn = await page.waitForSelector("button:has-text('Continue')");
  await continueBtn.click();

  // Locators re-resolve on every action: the form re-renders as it loads, which
  // detaches element handles grabbed too early ("Element is not attached").
  const form = page.locator("gg-geeklist-item-edit-new");
  await form.waitFor();
  await form.locator("textarea[name='text']").fill(renderBody(template, effectiveRow, boilerplate));
  await ensureSubscribed(page, form.locator("input[name='subs']"));

  if (opts.live) {
    await form.locator("button:has-text('Save')").click();
    await form.waitFor({ state: "detached", timeout: 15000 });
    recordPosted(opts.history, history, opts.geeklist, chosen, effectiveRow.price);
    console.log(`  Posted.`);
    return "posted";
  }

  const screenshotPath = path.join(ROOT, `dry-run-${shotNumber}.png`);
  await page.screenshot({ path: screenshotPath });
  console.log(`  Dry run: filled form, screenshot saved to ${screenshotPath}`);
  await form.locator("button:has-text('Cancel')").click();
  await form.waitFor({ state: "detached", timeout: 15000 });
  return "dry-run";
}

async function main() {
  const opts = parseArgs();

  if (opts.interactive && opts.csvGiven) {
    console.error("--interactive and --csv are mutually exclusive.");
    process.exit(1);
  }
  if (!opts.interactive && !fs.existsSync(opts.csv)) {
    console.error(`CSV not found: ${opts.csv}`);
    process.exit(1);
  }
  requireLogin();

  const boilerplate = readOptional(opts.boilerplate);
  const template = readOptional(opts.template, DEFAULT_TEMPLATE);
  const history = loadHistory(opts.history);

  let limited = [];
  if (opts.interactive) {
    console.log("Interactive mode: enter game names one at a time; a blank name finishes.");
  } else {
    const rows = parse(fs.readFileSync(opts.csv, "utf8"), { columns: true, skip_empty_lines: true, trim: true });
    limited = rows.slice(0, opts.limit);
    console.log(`Loaded ${rows.length} row(s) from ${opts.csv}${opts.limit < rows.length ? `, processing first ${limited.length}` : ""}.`);
  }
  console.log(opts.live ? "Mode: LIVE — items will actually be posted." : "Mode: DRY RUN — items are filled in and then cancelled, nothing is posted. Pass --live to post for real.");

  // Interactive mode has no fixed batch to confirm; each item is still
  // disambiguated and priced by hand before it is saved.
  if (opts.live && !opts.interactive) {
    const proceed = await confirm({
      message: `This will add ${limited.length} real item(s) to the live geeklist. Continue?`,
      default: false,
    });
    if (!proceed) {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  const { browser, context } = await launchSession();
  // Price lookups reuse one tab for the whole run (see getBggRecentSales). It's
  // opened first so the geeklist tab stays the active one.
  const pricePage = opts.checkPrices ? await context.newPage() : null;
  const page = await context.newPage();

  await page.goto(opts.geeklist, { waitUntil: "networkidle" });

  const ctx = { opts, page, pricePage, history, template, boilerplate, skipped: [] };
  let posted = 0;

  try {
    if (opts.interactive) {
      let count = 0;
      while (true) {
        const game = (await input({ message: "Game name (blank to finish):" })).trim();
        if (!game) break;
        const condition = (await input({ message: "  Condition (blank for none):" })).trim();
        count++;
        console.log(`\n[${count}] ${game}`);
        if ((await processRow(ctx, { game, condition, price: "" }, count)) === "posted") posted++;
      }
    } else {
      for (const [i, row] of limited.entries()) {
        console.log(`\n[${i + 1}/${limited.length}] ${row.game}`);
        const result = await processRow(ctx, row, i + 1);
        if (result === "posted") posted++;
        // Skips return early, before anything was submitted, so no pacing delay.
        if (result !== "skipped") await sleep(opts.delayMs + Math.floor(Math.random() * 1500));
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\nDone. ${opts.live ? `Posted ${posted} item(s).` : "Dry run complete, nothing was posted."}`);
  if (ctx.skipped.length > 0) {
    const skippedPath = path.join(ROOT, "skipped.csv");
    fs.writeFileSync(skippedPath, stringify(ctx.skipped, { header: true }));
    console.log(`${ctx.skipped.length} row(s) need manual attention — see ${skippedPath}`);
  }
}

main();
