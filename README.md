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

If a game name matches more than one BGG entry, you'll get an interactive prompt in
the terminal to pick the right one (or skip the row). Rows with no BGG match, or
that you skip, are written to `skipped.csv` for manual follow-up.

## 4. Post for real

```sh
bun run post -- --csv items.csv --boilerplate boilerplate.txt --live
```

Same as above, but actually clicks Save for each item and asks for a final
confirmation before starting. Runs with a few seconds of randomized delay between
items to behave like a normal user, not a scraper.

## Other flags

- `--geeklist <url>` — defaults to the Portland flea market v2.0 list.
- `--limit N` — only process the first N rows (good for testing).
- `--delay-ms N` — base delay between items in milliseconds (default 4000, jittered).
- `--template <path>` / `--boilerplate <path>` / `--csv <path>` — override file locations.
- `--check-prices` — after you pick the right game, looks up pricing data and lets
  you confirm or override the CSV price before it's used:
  - BGG's own GeekMarket Price History (actual recent sales, filtered to USD),
    shown overall and, if the CSV `condition` matches one of BGG's standard
    condition labels (New, Like New, Very Good, Good, Acceptable), broken out
    for that condition specifically.
  - BoardGameOracle's lowest current new/retail price, as a reference ceiling.
  You get a prompt with a suggested default (the condition-matched median sale
  price when available) that you can accept or type over.
