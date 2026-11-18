import test from "node:test";
import assert from "node:assert/strict";
import { planBoilerplateVisit, resolveBoilerplate } from "./markup.mjs";

test("items recorded as already having the new text aren't visited", () => {
  assert.deepEqual(planBoilerplateVisit({ recorded: "new", newText: "new\n" }), { visit: false, reason: "current" });
  assert.equal(planBoilerplateVisit({ recorded: "new", newText: "new", recheck: true }).visit, true);
});

test("items with no record are visited only if --old supplies a candidate", () => {
  assert.deepEqual(planBoilerplateVisit({ recorded: null, newText: "new" }), { visit: false, reason: "unknown" });
  assert.deepEqual(planBoilerplateVisit({ recorded: null, oldText: "old", newText: "new" }), { visit: true, candidates: ["old"] });
});

test("the recorded text is tried before --old, and duplicates collapse", () => {
  assert.deepEqual(planBoilerplateVisit({ recorded: "a", oldText: "b", newText: "new" }).candidates, ["a", "b"]);
  assert.deepEqual(planBoilerplateVisit({ recorded: "a", oldText: "a", newText: "new" }).candidates, ["a"]);
});

test("resolveBoilerplate swaps whichever candidate is in the body", () => {
  const r = resolveBoilerplate("Price: $5\n\nb text", ["a text", "b text"], "new text");
  assert.equal(r.status, "replaced");
  assert.equal(r.from, "b text");
  assert.equal(r.body, "Price: $5\n\nnew text");
  assert.equal(resolveBoilerplate("x new text", ["a text"], "new text").status, "already");
  assert.equal(resolveBoilerplate("x", ["a text"], "new text").status, "missing");
  assert.equal(resolveBoilerplate("x new text", [], "new text").status, "already");
});
