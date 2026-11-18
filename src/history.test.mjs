import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordPosted, setItemId, setBoilerplate, findByItemId, findPosted, ledgerItems, planSync, applySync, updatePrice, removePosted } from "./history.mjs";

const URL = "https://boardgamegeek.com/geeklist/1/x";
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-")), "posted.json");

test("the same game posted twice is two entries, each with its own item id", () => {
  const file = tmp();
  const h = {};
  const a = recordPosted(file, h, URL, { id: "5", label: "Catan (1995)", itemId: "100" }, "20");
  const b = recordPosted(file, h, URL, { id: "5", label: "Catan (1995)", itemId: "200" }, "18");
  assert.notEqual(a, b);
  assert.deepEqual(ledgerItems(h, URL).items.map((i) => i.itemId), ["100", "200"]);
  assert.equal(findPosted(h, URL, { id: "5", label: "Catan (1995)" }), a);
  updatePrice(file, h, URL, { itemId: "200" }, "15");
  assert.equal(h["1"]["200"].price, "15");
  assert.equal(h["1"]["100"].price, "20");
  assert.ok(removePosted(file, h, URL, { itemId: "100" }));
  assert.deepEqual(Object.keys(h["1"]), ["200"]);
});

test("a post without a known item id is re-keyed once the id is found", () => {
  const file = tmp();
  const h = {};
  const e = recordPosted(file, h, URL, { id: "5", label: "Catan (1995)" }, "20");
  assert.equal(ledgerItems(h, URL).missingIds, 1);
  assert.ok(setItemId(file, h, URL, e, 300));
  assert.deepEqual(Object.keys(h["1"]), ["300"]);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))["1"]["300"].itemId, "300");
});

test("planSync pairs legacy entries, adds unknown items and reports orphans", () => {
  const h = {
    1: {
      5: { id: "5", label: "Catan (1995)", price: "20" },
      "label:mystery": { id: null, label: "Mystery", price: "5" },
      9: { id: "9", label: "Gone (2000)", price: "1" },
      700: { itemId: "700", id: "7", label: "Known (2001)", price: "2" },
    },
  };
  const own = [
    { itemId: "100", bggId: "5", title: "Catan (1995)" },
    { itemId: "700", bggId: "7", title: "Known (2001)" },
    { itemId: "800", bggId: "8", title: "New (2002)" },
  ];
  const plan = planSync(h, URL, own);
  assert.deepEqual(plan.assign.map((a) => a.item.itemId), ["100"]);
  assert.deepEqual(plan.add.map((i) => i.itemId), ["800"]);
  assert.deepEqual(plan.orphans.map((e) => e.label).sort(), ["Gone (2000)", "Mystery"]);
  applySync(tmp(), h, URL, plan);
  assert.deepEqual(Object.keys(h["1"]).sort(), ["100", "700", "800", "9", "label:mystery"]);
  assert.equal(h["1"]["100"].itemId, "100");
  assert.equal(h["1"]["800"].price, null);
});

test("planSync pairs an entry with no BGG id by title, ignoring the year", () => {
  const h = { 1: { "label:jinns": { id: null, label: "Jinns of the lake (2020)", price: "5" } } };
  const plan = planSync(h, URL, [{ itemId: "9", bggId: "42", title: "Jinns of the lake" }]);
  assert.equal(plan.assign.length, 1);
  assert.equal(plan.add.length, 0);
});

test("setBoilerplate records what an item contains and only writes on change", () => {
  const file = tmp();
  const h = {};
  const e = recordPosted(file, h, URL, { id: "5", label: "Catan (1995)", itemId: "100" }, "20", "text A");
  assert.equal(e.boilerplate, "text A");
  const before = fs.statSync(file).mtimeMs;
  setBoilerplate(file, h, e, "text A");
  assert.equal(fs.statSync(file).mtimeMs, before);
  setBoilerplate(file, h, e, "text B");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))["1"]["100"].boilerplate, "text B");
  setBoilerplate(file, h, null, "ignored");
  assert.equal(findByItemId(h, URL, "100"), e);
});
