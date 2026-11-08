import { test } from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, { DB_PATH: ":memory:", PAYPAL_CLIENT_ID: "test", PAYPAL_CLIENT_SECRET: "test" });
const { handleEvent, db } = await import("./server.js");

db.prepare("INSERT INTO tabs (id, title, organiser, payee_email, total_cents) VALUES ('t1', 'Dinner', 'Sami', 's@x', 3000)").run();
db.prepare("INSERT INTO items (id, tab_id, name, cents) VALUES (1, 't1', 'Steak', 3000)").run();
db.prepare("INSERT INTO claims (item_id, person) VALUES (1, 'Anna')").run();
db.prepare("INSERT INTO shares (tab_id, person, cents, order_id, status) VALUES ('t1', 'Anna', 3000, 'O-1', 'confirming')").run();

const completed = { id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1", supplementary_data: { related_ids: { order_id: "O-1" } } } };
const status = () => db.prepare("SELECT status FROM shares WHERE order_id = 'O-1'").get().status;
const feed = () => db.prepare("SELECT text FROM feed WHERE tab_id = 't1' ORDER BY id").all().map((r) => r.text);

test("a capture webhook marks the share paid once, even when PayPal delivers it twice", () => {
  handleEvent(completed);
  handleEvent(completed); // PayPal retry: same event id
  handleEvent({ ...completed, id: "WH-2" }); // a different event for the same capture
  assert.equal(status(), "paid");
  assert.equal(feed().filter((t) => t.startsWith("✅")).length, 1);
  assert.ok(feed().some((t) => t.startsWith("🎉")), "tab is settled when everyone has paid");
});

test("a late decline can't undo a confirmed payment", () => {
  handleEvent({ ...completed, id: "WH-3", event_type: "PAYMENT.CAPTURE.DECLINED" });
  assert.equal(status(), "paid");
});

test("events for orders that aren't ours are ignored", () => {
  assert.equal(handleEvent({ ...completed, id: "WH-4", resource: { supplementary_data: { related_ids: { order_id: "nope" } } } }), null);
});
