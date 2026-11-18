// Spaces out the importer's requests to BGG. Every page load or API call goes
// through `paced`, which waits until at least the gap (plus up to 50% random
// extra) has passed since the previous one finished, so even a long read-only
// run stays slow and steady instead of loading pages back to back.

export const DEFAULT_REQUEST_DELAY_MS = 3000;

let gapMs = DEFAULT_REQUEST_DELAY_MS;
let lastFinished = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function setRequestDelay(ms) {
  if (!Number.isInteger(ms) || ms < 0) {
    console.error("--request-delay-ms needs a whole number of milliseconds, 0 or more.");
    process.exit(1);
  }
  gapMs = ms;
}

export async function paced(request) {
  const wait = lastFinished + gapMs + Math.floor(Math.random() * (gapMs / 2)) - Date.now();
  if (wait > 0) await sleep(wait);
  try {
    return await request();
  } finally {
    lastFinished = Date.now();
  }
}
