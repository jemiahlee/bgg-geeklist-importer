import { select } from "@inquirer/prompts";
import { paced } from "./pace.mjs";

// Item-level Edit/Delete live directly under the item's action bar. Scoping to
// it (and matching the exact label) keeps comment buttons and "Mark Sold" out.
const ACTION_BAR_BUTTONS = "nav.geeklist-item__divider > button.btn";

const pageBase = (geeklistUrl) => geeklistUrl.split(/[?#]/)[0];

export function itemUrl(geeklistUrl, itemId) {
  return `${pageBase(geeklistUrl)}?itemid=${itemId}`;
}

const ITEMS_PER_PAGE = 25;

// The geeklist header shows its total ("390 Items"), which fixes how many pages
// there are and how many items each should hold, so a slow or partial page can
// be told apart from the real end of the list.
async function readPage(page, geeklistUrl, n, totals) {
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    await paced(() => page.goto(`${pageBase(geeklistUrl)}?page=${n}`, { waitUntil: "networkidle" }));
    await page.waitForSelector("gg-geeklist-item", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    const text = await page.locator("body").innerText();
    const total = Number(text.match(/([\d,]+) Items\b/)?.[1].replace(/,/g, ""));
    const items = await page.$$eval(
      "gg-geeklist-item",
      (els, sel) =>
        els.map((el) => {
          const buttons = [...el.querySelectorAll(sel)].map((b) => b.textContent.trim());
          const comments = [...el.querySelectorAll("button")]
            .map((b) => b.textContent.match(/View (\d+) Comment/))
            .find(Boolean);
          return {
            itemId: el.querySelector("a[id^='item']")?.id.replace("item", ""),
            href: el.querySelector("h2 a[href^='/boardgame']")?.getAttribute("href") ?? "",
            heading: el.querySelector("h2")?.textContent.replace(/\s+/g, " ").trim() ?? "",
            own: buttons.includes("Delete"),
            comments: comments ? Number(comments[1]) : 0,
          };
        }),
      ACTION_BAR_BUTTONS
    );
    const reported = totals?.total ?? total;
    const lastPage = Math.ceil(reported / ITEMS_PER_PAGE);
    result = { items, total: reported, lastPage };
    const expected = n >= lastPage ? reported - ITEMS_PER_PAGE * (lastPage - 1) : ITEMS_PER_PAGE;
    if (Number.isFinite(expected) && items.length === expected) return result;
  }
  throw new Error(`Page ${n} of the geeklist didn't load the expected items (got ${result.items.length}); stopping rather than act on a partial list.`);
}

// Walks the geeklist a page at a time and yields the items that belong to the
// logged-in user (the only ones that show a Delete button) as each page is read,
// so callers can start work, and stop early, without waiting for the whole list.
// Once the walk completes it checks itself against the reported item total and
// throws rather than let a caller believe it saw a partial list in full.
export async function* iterateOwnItems(page, geeklistUrl) {
  const seen = new Set();
  let totals = null;
  for (let n = 1; ; n++) {
    const result = await readPage(page, geeklistUrl, n, totals);
    totals ??= { total: result.total, lastPage: result.lastPage };
    for (const i of result.items) {
      if (!i.itemId || seen.has(i.itemId)) continue;
      seen.add(i.itemId);
      if (!i.own) continue;
      yield {
        itemId: i.itemId,
        bggId: i.href.split("/")[2] ?? null,
        title: i.heading.replace(/^\d+\.\s*/, ""),
        comments: i.comments,
      };
    }
    if (n >= totals.lastPage) break;
  }
  if (seen.size !== totals.total) {
    throw new Error(`Scanned ${seen.size} items but the geeklist reports ${totals.total}; stopping rather than act on a partial list.`);
  }
}

export async function scanOwnItems(page, geeklistUrl) {
  const own = [];
  for await (const item of iterateOwnItems(page, geeklistUrl)) own.push(item);
  return own;
}

// Finds the geeklist item ids of items just posted. New items go on the end of
// the list, so this walks backwards from the last page, handing each of the
// user's newest items to the latest unresolved entry of `pending` ({ bggId })
// for the same game. Items in `known` (ids the ledger already has) are never
// taken. Returns itemIds aligned with `pending`; null where nothing was found.
export async function findNewItemIds(page, geeklistUrl, pending, known, { maxPages = 6 } = {}) {
  const found = pending.map(() => null);
  const unresolved = () => found.some((id, i) => id === null && pending[i].bggId);
  const first = await readPage(page, geeklistUrl, 1);
  const totals = { total: first.total, lastPage: first.lastPage };
  for (let n = totals.lastPage; n >= 1 && n > totals.lastPage - maxPages && unresolved(); n--) {
    const { items } = n === 1 ? first : await readPage(page, geeklistUrl, n, totals);
    for (const item of [...items].reverse()) {
      const bggId = item.href.split("/")[2];
      if (!item.own || !item.itemId || known.has(item.itemId)) continue;
      let slot = -1;
      for (let i = pending.length - 1; i >= 0; i--) {
        if (found[i] === null && pending[i].bggId === bggId) { slot = i; break; }
      }
      if (slot >= 0) found[slot] = item.itemId;
    }
  }
  return found;
}

// Ledger labels carry the year ("Nippon (2015)"), CSV rows usually don't.
function normalize(s) {
  return s.replace(/\s*\(\d{4}\)\s*$/, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Pairs each CSV row (a `bgg_id` or a `game` name) with one of the user's own
// items. A BGG id or an exact title match is taken as-is; anything looser is
// put to the user to choose, and nothing is guessed. Each item is used once.
export async function matchRows(rows, ownItems) {
  const matches = [];
  const unmatched = [];
  const used = new Set();

  for (const row of rows) {
    const name = row.game ?? row.bgg_id;
    const available = ownItems.filter((i) => !used.has(i.itemId));
    let candidates;
    let exact = true;
    if (row.bgg_id) {
      candidates = available.filter((i) => i.bggId === String(row.bgg_id).trim());
    } else if (row.game) {
      const want = normalize(row.game);
      candidates = available.filter((i) => normalize(i.title) === want);
      if (candidates.length === 0) {
        const words = want.split(" ");
        candidates = available.filter((i) => words.every((w) => normalize(i.title).split(" ").includes(w)));
        exact = false;
      }
    } else {
      unmatched.push({ row, reason: "row has neither game nor bgg_id" });
      continue;
    }

    if (candidates.length === 0) {
      unmatched.push({ row, reason: `no item of yours matches "${name}"` });
      continue;
    }
    let item = candidates[0];
    if (candidates.length > 1 || !exact) {
      const choice = await select({
        message: `${candidates.length > 1 ? "Multiple" : "A possible"} match for "${name}" — pick the right one:`,
        choices: [
          ...candidates.map((c) => ({ name: `${c.title} (item ${c.itemId})`, value: c })),
          { name: "(skip this row)", value: null },
        ],
      });
      if (!choice) {
        unmatched.push({ row, reason: "skipped during disambiguation" });
        continue;
      }
      item = choice;
    }
    used.add(item.itemId);
    matches.push({ row, item });
  }
  return { matches, unmatched };
}

// Jumps straight to the page holding the item (so page shifts after earlier
// deletions don't matter) and returns its locator.
export async function gotoItem(page, geeklistUrl, itemId) {
  await paced(() => page.goto(itemUrl(geeklistUrl, itemId), { waitUntil: "networkidle" }));
  const item = page.locator("gg-geeklist-item", { has: page.locator(`a#item${itemId}`) });
  await item.waitFor({ timeout: 15000 });
  return item;
}

// The item's own action-bar button with exactly this label. Throws unless there
// is exactly one, so a click can never land on a look-alike.
export async function actionButton(item, label) {
  const button = item.locator(ACTION_BAR_BUTTONS).filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) });
  const count = await button.count();
  if (count !== 1) throw new Error(`Expected exactly one "${label}" button on the item, found ${count}.`);
  return button;
}

export async function openEditor(item) {
  await (await actionButton(item, "Edit")).click();
  const form = item.page().locator("gg-geeklist-item-edit");
  const textarea = form.locator("textarea[name='text']");
  await textarea.waitFor({ timeout: 15000 });
  return { form, textarea };
}

export async function cancelEditor(form) {
  await form.locator("button:visible", { hasText: /^\s*Cancel\s*$/ }).click();
  await form.waitFor({ state: "detached", timeout: 15000 });
}

export async function saveEditor(form) {
  await form.locator("button:visible", { hasText: /^\s*Save\s*$/ }).click();
  await form.waitFor({ state: "detached", timeout: 15000 });
}

// What the item on screen says about itself, to check it is the item we think it is.
export async function readItemInfo(item) {
  return item.evaluate(
    (el, sel) => {
      const comments = [...el.querySelectorAll("button")].map((b) => b.textContent.match(/View (\d+) Comment/)).find(Boolean);
      return {
        bggId: el.querySelector("h2 a[href^='/boardgame']")?.getAttribute("href").split("/")[2] ?? null,
        title: el.querySelector("h2")?.textContent.replace(/\s+/g, " ").trim().replace(/^\d+\.\s*/, "") ?? "",
        own: [...el.querySelectorAll(sel)].some((b) => b.textContent.trim() === "Delete"),
        comments: comments ? Number(comments[1]) : 0,
      };
    },
    ACTION_BAR_BUTTONS
  );
}

// The editor may hand back CRLF line endings; compare and write with LF.
export const lf = (text) => text.replace(/\r\n/g, "\n");

// Visits one item, checks it is the item expected (`expected.bggId`, when known),
// opens its editor and passes the body (LF-normalised) to `decide`. `decide`
// returns { newBody } to have it saved, or null to leave the item alone. A save
// is only made after reading the textarea back to confirm the form kept the text.
//
// Resolves to { status: "saved" | "left" | "failed", reason?, info }. "failed"
// means the item couldn't be edited (gone, not yours, not the expected game, the
// form lost the text); "left" means `decide` chose not to change it.
export async function editItemBody(page, geeklistUrl, expected, decide) {
  let item, info, form, textarea;
  try {
    item = await gotoItem(page, geeklistUrl, expected.itemId);
    info = await readItemInfo(item);
    if (expected.bggId && info.bggId && info.bggId !== String(expected.bggId)) {
      return { status: "failed", info, reason: `item ${expected.itemId} is BGG game ${info.bggId} ("${info.title}"), not ${expected.bggId} as recorded` };
    }
    ({ form, textarea } = await openEditor(item));
  } catch (err) {
    return { status: "failed", info, reason: `couldn't open item ${expected.itemId} for editing: ${err.message.split("\n")[0]}` };
  }
  try {
    const body = lf(await textarea.inputValue());
    const decision = await decide(body, info);
    if (!decision) return { status: "left", info };
    await textarea.fill(decision.newBody);
    // A fill can be lost if the form re-renders; never save unless it took.
    await page.waitForTimeout(600);
    if (lf(await textarea.inputValue()) !== decision.newBody) {
      return { status: "failed", info, reason: "the form did not keep the new text" };
    }
    await saveEditor(form);
    form = null;
    return { status: "saved", info };
  } finally {
    if (form) await cancelEditor(form).catch(() => {});
  }
}
