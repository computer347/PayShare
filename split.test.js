import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, splitTab, checkReceipt, UNCLAIMED } from "./split.js";
import { toClaimableItems } from "./receipt.js";

test("multi-unit receipt lines become one claimable row per unit", () => {
  const rows = toClaimableItems({ items: [{ name: "Beer", quantity: 3, line_total_cents: 2000 }, { name: "Fries", quantity: 1, line_total_cents: 450 }] });
  assert.deepEqual(rows.map((r) => r.cents), [667, 667, 666, 450]);
  assert.ok(rows.every((r) => r.name));
});

test("discount and void lines fold into the item above", () => {
  const rows = toClaimableItems({
    items: [
      { name: "Cheese", quantity: 1, line_total_cents: 588 },
      { name: "Cheese (VOIDED)", quantity: 1, line_total_cents: -588 },
      { name: "Coffee", quantity: 1, line_total_cents: 548 },
      { name: "DISCOUNT", quantity: 1, line_total_cents: -57 },
    ],
  });
  assert.deepEqual(rows, [{ name: "Coffee", cents: 491 }]);
});

test("allocate sums exactly and is deterministic", () => {
  assert.deepEqual(allocate(1000, [1, 1, 1]), [334, 333, 333]);
  assert.deepEqual(allocate(5, [0, 0]), [0, 0]);
  assert.deepEqual(allocate(100, [1, 3]), [25, 75]);
});

test("dinner from the pitch: shared wine, unclaimed tiramisu, tip proportional", () => {
  const items = [
    { id: 1, name: "Steak", cents: 3000 },
    { id: 2, name: "Pasta", cents: 1800 },
    { id: 3, name: "Wine", cents: 2400 },
    { id: 4, name: "Tiramisu", cents: 900 },
  ];
  const claims = [
    { itemId: 1, person: "Mike" },
    { itemId: 2, person: "Anna" },
    { itemId: 3, person: "Anna" },
    { itemId: 3, person: "Jussi" },
  ];
  const s = splitTab({ items, claims, totalCents: 8910 }); // 8100 items + 810 tip (10%)
  assert.equal(s.Mike.total, 3300);
  assert.equal(s.Anna.total, 3300); // 1800 + 1200 wine + 300 tip
  assert.equal(s.Jussi.total, 1320);
  assert.equal(s[UNCLAIMED].total, 990);
  assert.equal(s.Anna.items.find((i) => i.name === "Wine").sharedWith, 2);
});

test("odd cents never go missing", () => {
  const items = [{ id: 1, name: "Pizza", cents: 1001 }];
  const claims = ["A", "B", "C"].map((person) => ({ itemId: 1, person }));
  const s = splitTab({ items, claims, totalCents: 1103 });
  assert.equal(s.A.total + s.B.total + s.C.total, 1103);
});

test("checkReceipt flags AI arithmetic mistakes", () => {
  const items = [{ name: "Steak", cents: 3000 }, { name: "Pasta", cents: 1800 }];
  assert.equal(checkReceipt({ items, subtotalCents: 4800, totalCents: 5280 }).ok, true);
  const bad = checkReceipt({ items, subtotalCents: 4900, totalCents: 5280 });
  assert.equal(bad.ok, false);
  assert.match(bad.issues[0], /off by 100/);
  assert.equal(checkReceipt({ items: [{ name: "x", cents: 12.5 }], totalCents: 100 }).ok, false);
});
