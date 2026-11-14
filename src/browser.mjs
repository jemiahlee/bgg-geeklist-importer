import { chromium } from "playwright";
import fs from "node:fs";
import { STORAGE_STATE_PATH } from "./config.mjs";

export const DEFAULT_GEEKLIST = "https://boardgamegeek.com/geeklist/343300/portland-or-area-virtual-flea-market-v20";

export function requireLogin() {
  if (!fs.existsSync(STORAGE_STATE_PATH)) {
    console.error(`No saved login session found at ${STORAGE_STATE_PATH}. Run "bun run login" first.`);
    process.exit(1);
  }
}

// Launches Chrome with the saved BGG login. Callers open their own pages.
export async function launchSession() {
  requireLogin();
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
  return { browser, context };
}
