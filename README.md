# bgg-geeklist-importer

Bulk-add items to a BoardGameGeek GeekList from a CSV, by driving a real logged-in
browser through the same "Add Item" flow a person would use. (BGG's API doesn't
support writing to GeekLists, and its site is behind Cloudflare bot protection, so
this uses your real installed Chrome rather than an API client.)

## Setup

```sh
bun install
bunx playwright install chromium
```

## 1. Log in once

```sh
bun run login
```

Opens a real Chrome window to the BGG login page. Log in there, then press Enter in
the terminal. Your session is saved to `storage-state.json` (gitignored, local only,
never sent anywhere) and reused by later runs so you don't have to log in every time.
Re-run this if the session expires.

## 2. Prepare your input files

- `items.csv` — copy `items.sample.csv` and fill in your real rows. Columns: `game,price,condition`.
- `boilerplate.txt` — copy `boilerplate.sample.txt`; this text is appended to every item.
- `template.txt` — controls how each item's body is composed, using `{{game}}`,
  `{{price}}`, `{{condition}}`, `{{boilerplate}}` placeholders. Edit if you want a
  different layout.

## 3. Dry run

```sh
bun run post -- --csv items.csv --boilerplate boilerplate.txt
```

By default nothing is posted: for each row it opens the Add Item form, searches
BGG, fills in the body, screenshots the filled-in form to `dry-run-N.png`, then
cancels. Review the screenshots before going live.

If a game name matches more than one BGG entry, the terminal lists each match with its
BGG link, then prompts you to pick the right one (or skip the row). Rows with no BGG match, or
that you skip, are written to `skipped.csv` for manual follow-up.

## 4. Post for real

```sh
bun run post -- --csv items.csv --boilerplate boilerplate.txt --live
```

Same as above, but actually clicks Save for each item and asks for a final
confirmation before starting. Runs with a few seconds of randomized delay between
items to behave like a normal user, not a scraper.

## Duplicate protection

Every item posted with `--live` is recorded in `posted.json` (gitignored), keyed by
geeklist and the BGG ID of the item you picked (so distinct games that share a name and
year, like the two "Flowers (2024)", are tracked separately). If a later run reaches an item that was already
posted to the same geeklist, you're told when it was posted and can skip it, skip it
and every other previously posted item for the rest of the run, or post it again. Pass
`--skip-posted` to skip them all without being asked, so the same CSV can be re-run
as-is (e.g. after adding rows or fixing skipped ones). Dry runs never write to the ledger. Delete an entry from
`posted.json` (or the whole file) to forget it.

## Other flags

- `--skip-posted` — silently skip items already in the ledger (see above).
- `--history <path>` — ledger file location (default `posted.json`).
- `--geeklist <url>` — defaults to the Portland flea market v2.0 list.
- `--limit N` — only process the first N rows (good for testing).
- `--delay-ms N` — base delay between items in milliseconds (default 4000, jittered).
- `--template <path>` / `--boilerplate <path>` / `--csv <path>` — override file locations.
- `--no-check-prices` — skip the price lookup and use the CSV price as-is. By default,
  after you pick the right game, the importer looks up pricing data and lets
  you confirm or override the CSV price before it's used:
  - BGG's own GeekMarket Price History (actual recent sales, filtered to USD),
    shown overall and, if the CSV `condition` matches one of BGG's standard
    condition labels (New, Like New, Very Good, Good, Acceptable), broken out
    for that condition specifically. If the sales span more than $30, the 5 most
    recent are also listed individually, with links.
  - BoardGameOracle's lowest current new/retail price, as a reference ceiling.
  - Noble Knight Games' cheapest in-stock listings (new and used, with their
    condition grades) for the game. Expansions and oddly titled products may
    not match and will show "no match found".
  You get a prompt with a suggested default (the condition-matched median sale
  price when available) that you can accept or type over. Type `skip` instead of a
  price to skip the item; it's listed in `skipped.csv` for later.

## Repricing items

`bun run reprice` lowers the price on items you've already posted. It reads a CSV
with `game,price` (or `bgg_id,price`; see `reprice.sample.csv`), where `price` is the
new price, and defaults to `reprice.csv`.

For each row it finds your matching item on the geeklist (an exact title or BGG ID
match is taken as-is; a looser match asks you to pick), reads the item's current
`Price:` line, and strikes it through with the new price after it. Repricing again
keeps the earlier strikethroughs:

```
Price: $25
Price: [-]$25[/-] $20
Price: [-]$25[/-] [-]$20[/-] $15
```

It compares against what is on BGG, so re-running the same CSV is harmless: items
already at the new price are left alone. Rows that aren't a reduction, have no
`Price:` line, or don't match one of your items are skipped and listed in
`skipped-reprice.csv`. Like posting, it is a dry run (it prints the planned edits)
until you pass `--live`, which asks for confirmation first. Edited items also get
their price updated in `posted.json`.

Flags: `--csv`, `--geeklist`, `--history`, `--live`, `--delay-ms`.

## Deleting items

`bun run delete` removes items from the geeklist. **Deletion is permanent; BGG has no
undo.** It reads a CSV with `game` (or `bgg_id`); see `delete.sample.csv`. The default
is `delete.csv`.

It finds your matching items the same way `reprice` does, then prints exactly what it
would delete (title, link, the price from `posted.json`, and a warning if the item has
comments). Nothing is deleted until you pass `--live` and answer yes to a confirmation
that defaults to no. It only ever clicks an item's own Delete button, never Mark Sold.
If anything unexpected happens (a button or dialog it doesn't recognise, an item that
is still there afterwards) it stops instead of continuing. Deleted items are removed
from `posted.json`, so a later post won't think they're still listed. Rows that don't
match are listed in `skipped-delete.csv`.

Try your first `--live` run with a one-row CSV.

Flags: `--csv`, `--geeklist`, `--history`, `--live`, `--delay-ms`.
