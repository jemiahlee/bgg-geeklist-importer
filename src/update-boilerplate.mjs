import { stringify } from "csv-stringify/sync";
import { expand } from "@inquirer/prompts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GEEKLIST, requireLogin, launchSession } from "./browser.mjs";
import { scanOwnItems, gotoItem, openEditor, cancelEditor, saveEditor, readBody, itemUrl } from "./geeklist.mjs";
import { replaceBoilerplate } from "./markup.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    old: null,
    new: null,
    geeklist: DEFAULT_GEEKLIST,
    live: false,
    limit: Infinity,
    delayMs: 4000,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--old") opts.old = path.resolve(args[++i]);
    else if (a === "--new") opts.new = path.resolve(args[++i]);
    else if (a === "--geeklist") opts.geeklist = args[++i];
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

// The editor may hand back CRLF line endings; compare and write with LF.
const lf = (text) => text.replace(/\r\n/g, "\n");

function readText(file, flag) {
  if (!file) {
    console.error(`Missing ${flag} <file>. Usage: bun run update-boilerplate -- --old old.txt --new new.txt [--live]`);
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
  const oldText = readText(opts.old, "--old");
  const newText = readText(opts.new, "--new");
  if (oldText === newText) {
    console.error("The old and new boilerplate files are identical; nothing to update.");
    process.exit(1);
  }
  requireLogin();

  console.log("Replacing this boilerplate:\n");
  console.log(indent(oldText));
  console.log("\nwith this:\n");
  console.log(indent(newText));
  console.log(opts.live ? "\nMode: LIVE — items will actually be edited." : "\nMode: DRY RUN — nothing is edited. Pass --live to edit for real.");

  const skipped = [];
  const { browser, context } = await launchSession();
  try {
    const page = await context.newPage();
    console.log("\nScanning the geeklist for your items...");
    const own = await scanOwnItems(page, opts.geeklist);
    console.log(`Found ${own.length} of your items. Reading ${opts.limit < own.length ? `them until ${opts.limit} need updating` : "each one"}...`);

    const plan = [];
    let already = 0;
    for (const item of own) {
      // With a limit, stop reading once enough items are lined up.
      if (plan.length >= opts.limit) break;
      const label = `${item.title} (item ${item.itemId})`;
      const body = lf(await readBody(page, opts.geeklist, item.itemId));
      const result = replaceBoilerplate(body, oldText, newText);
      if (result.status === "already") already++;
      else if (result.status === "missing") skipped.push({ itemId: item.itemId, title: item.title, reason: "old boilerplate text not found in the item" });
      else plan.push({ item, label, body, newBody: result.body });
    }
    console.log(`${plan.length} item(s) to update, ${already} already have the new text, ${skipped.length} without the old text${plan.length >= opts.limit ? " (stopped at --limit)" : ""}.`);

    // Show each result in full (price, condition and all) so nothing is a surprise.
    for (const p of plan) {
      console.log(`\n  ${p.label} — ${itemUrl(opts.geeklist, p.item.itemId)}`);
      console.log(indent(p.newBody));
    }

    let edited = 0;
    if (plan.length > 0 && !opts.live) {
      console.log("\nDry run: nothing was edited.");
    } else if (plan.length > 0) {
      console.log(`\nYou'll be asked before each edit: y = edit this item, n = skip it, a = edit it and all the rest without asking.`);
      let all = false;
      for (const p of plan) {
        if (!all) {
          // Enter alone means "no", so a stray keypress can't edit a live item.
          const answer = await expand({
            message: `Edit ${p.label}?`,
            default: "n",
            choices: [
              { key: "y", name: "Yes, edit this item", value: "y" },
              { key: "n", name: "No, skip this item", value: "n" },
              { key: "a", name: "All: edit this and every remaining item without asking", value: "a" },
            ],
          });
          if (answer === "n") {
            console.log(`  Skipped.`);
            skipped.push({ itemId: p.item.itemId, title: p.item.title, reason: "declined at the prompt" });
            continue;
          }
          if (answer === "a") all = true;
        }
        console.log(`\nEditing ${p.label}...`);
        const item = await gotoItem(page, opts.geeklist, p.item.itemId);
        const { form, textarea } = await openEditor(item);
        if (lf(await textarea.inputValue()) !== p.body) {
          console.log(`  The item changed since it was read. Skipping.`);
          skipped.push({ itemId: p.item.itemId, title: p.item.title, reason: "item changed during the run" });
          await cancelEditor(form);
          continue;
        }
        await textarea.fill(p.newBody);
        // A fill can be lost if the form re-renders; never save unless it took.
        await page.waitForTimeout(600);
        if (lf(await textarea.inputValue()) !== p.newBody) {
          console.log(`  The edit didn't take. Skipping.`);
          skipped.push({ itemId: p.item.itemId, title: p.item.title, reason: "form did not keep the new text" });
          await cancelEditor(form);
          continue;
        }
        await saveEditor(form);
        edited++;
        console.log(`  Saved.`);
        await sleep(opts.delayMs + Math.floor(Math.random() * 1500));
      }
    }

    console.log(`\nDone. ${opts.live ? `Edited ${edited} item(s).` : "Dry run complete."}`);
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
