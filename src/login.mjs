import { chromium } from "playwright";
import { STORAGE_STATE_PATH } from "./config.mjs";

// Use the real, installed Chrome (not Playwright's bundled Chromium) and strip
// the automation flag Cloudflare's bot check looks for. Playwright's default
// Chromium gets stuck in an endless Cloudflare challenge loop on BGG.
const browser = await chromium.launch({
  headless: false,
  channel: "chrome",
  args: ["--disable-blink-features=AutomationControlled"],
});
const context = await browser.newContext();
await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});
const page = await context.newPage();

await page.goto("https://boardgamegeek.com/login");

console.log("A browser window has opened. Log into BoardGameGeek there.");
console.log("Once you're logged in and can see your account, come back here and press Enter.");

await new Promise((resolve) => {
  process.stdin.once("data", resolve);
});

await context.storageState({ path: STORAGE_STATE_PATH });
console.log(`Session saved to ${STORAGE_STATE_PATH}`);

await browser.close();
process.exit(0);
