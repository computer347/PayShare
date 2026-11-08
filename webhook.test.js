import { test } from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, {
  DB_PATH: ":memory:", PAYPAL_CLIENT_ID: "test", PAYPAL_CLIENT_SECRET: "test", CHECKOUT_MINUTES: "15",
});
const { handleEvent, db, createCheckout, settle, release, releaseExpired, getTab, getShares, usePayPalForTests } = await import("./server.js");

const feed = (tabId) => db.prepare("SELECT text FROM feed WHERE tab_id = ? ORDER BY id").all(tabId).map((r) => r.text);

// ---- webhooks (receipt split) ----
db.prepare("INSERT INTO tabs (id, title, organiser, payee_email, total_cents) VALUES ('t1', 'Dinner', 'Sami', 's@x', 3000)").run();
db.prepare("INSERT INTO items (id, tab_id, name, cents) VALUES (1, 't1', 'Steak', 3000)").run();
db.prepare("INSERT INTO claims (item_id, person) VALUES (1, 'Anna')").run();
db.prepare("INSERT INTO shares (tab_id, person, cents, order_id, status) VALUES ('t1', 'Anna', 3000, 'O-1', 'confirming')").run();
const completed = { id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1", supplementary_data: { related_ids: { order_id: "O-1" } } } };
const status = () => db.prepare("SELECT status FROM shares WHERE order_id = 'O-1'").get().status;

test("a capture webhook marks the share paid once, even when PayPal delivers it twice", () => {
  assert.equal(handleEvent(completed).paidNow, true);
  assert.equal(handleEvent(completed).paidNow, false); // PayPal retry: same event id
  assert.equal(handleEvent({ ...completed, id: "WH-2" }).paidNow, false); // another event for the same capture
  assert.equal(status(), "paid");
  assert.equal(feed("t1").filter((t) => t.startsWith("✅")).length, 1);
  assert.ok(feed("t1").some((t) => t.startsWith("🎉")), "tab is settled when everyone has paid");
});

test("a late decline can't undo a confirmed payment", () => {
  handleEvent({ ...completed, id: "WH-3", event_type: "PAYMENT.CAPTURE.DECLINED" });
  assert.equal(status(), "paid");
});

test("events for orders that aren't ours are ignored", () => {
  assert.equal(handleEvent({ ...completed, id: "WH-4", resource: { supplementary_data: { related_ids: { order_id: "nope" } } } }).share, null);
});

// ---- group checkout state machine, with PayPal stubbed ----
function fakePayPal({ failCaptureOf } = {}) {
  const calls = [];
  usePayPalForTests(async (method, path) => {
    calls.push(path);
    const auth = path.match(/authorizations\/([^/]+)\/capture/)?.[1];
    if (auth && auth === failCaptureOf) throw Object.assign(new Error("422"), { data: { details: [{ issue: "INSTRUMENT_DECLINED" }] } });
    if (auth) return { id: `CAP-${auth}`, status: "COMPLETED" };
    return {};
  });
  return calls;
}
function checkoutWithHolds(names) {
  const { id } = createCheckout({ product: "lakeside-cabin", organiser: names[0], members: names.slice(1) });
  for (const s of getShares(id)) db.prepare("UPDATE shares SET status = 'held', authorization_id = ?, order_id = ? WHERE tab_id = ? AND person = ?").run(`A-${s.person}`, `O-${id}-${s.person}`, id, s.person);
  return id;
}

test("checkout splits the price exactly and starts open with a deadline", () => {
  const { id } = createCheckout({ product: "lakeside-cabin", organiser: "Sami", members: ["Anna", "Jussi"] });
  const shares = getShares(id);
  assert.equal(shares.reduce((a, s) => a + s.cents, 0), 48000);
  assert.deepEqual(shares.map((s) => s.cents).sort(), [16000, 16000, 16000]);
  assert.equal(getTab(id).status, "open");
  assert.ok(new Date(getTab(id).expires_at) > new Date());
  assert.ok(createCheckout({ product: "lakeside-cabin", organiser: "Solo", members: [] }).error, "needs at least one friend");
  assert.ok(createCheckout({ product: "free-yacht", organiser: "Sami", members: ["Anna"] }).error, "prices come from the server catalogue");
});

test("everyone in: every hold is captured once and the booking is confirmed", async () => {
  const calls = fakePayPal();
  const id = checkoutWithHolds(["Sami", "Anna", "Jussi"]);
  await settle(id);
  await settle(id); // a second trigger must do nothing
  assert.equal(getTab(id).status, "booked");
  assert.ok(getShares(id).every((s) => s.status === "confirming"));
  assert.equal(calls.filter((p) => p.endsWith("/capture")).length, 3);
  assert.ok(feed(id).some((t) => t.startsWith("🏡 Booked!")));
});

test("one capture fails: earlier captures are refunded, the rest released, nobody pays", async () => {
  const calls = fakePayPal({ failCaptureOf: "A-Anna" });
  const id = checkoutWithHolds(["Sami", "Anna", "Jussi"]);
  await settle(id);
  const st = Object.fromEntries(getShares(id).map((s) => [s.person, s.status]));
  assert.deepEqual(st, { Sami: "refunded", Anna: "released", Jussi: "released" });
  assert.equal(getTab(id).status, "failed");
  assert.ok(calls.some((p) => p === "/v2/payments/captures/CAP-A-Sami/refund"));
});

test("time runs out: every hold is released and the booking can't settle afterwards", async () => {
  const calls = fakePayPal();
  const id = checkoutWithHolds(["Sami", "Anna"]);
  db.prepare("UPDATE tabs SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), id);
  await releaseExpired();
  assert.equal(getTab(id).status, "released");
  assert.ok(getShares(id).every((s) => s.status === "released"));
  await settle(id);
  assert.equal(calls.filter((p) => p.endsWith("/capture")).length, 0, "no capture after release");
});

test("cancel releases holds once", async () => {
  const calls = fakePayPal();
  const id = checkoutWithHolds(["Sami", "Anna"]);
  await release(id, "cancelled");
  await release(id, "cancelled again");
  assert.equal(calls.filter((p) => p.endsWith("/void")).length, 2);
});

// ---- agent tools: proposals never move money until the organiser confirms ----
const { agentTools, confirmProposal } = await import("./server.js");

test("agent proposals do nothing until the organiser confirms, and tokens work once", async () => {
  fakePayPal();
  const { id } = createCheckout({ product: "lakeside-cabin", organiser: "Sami", members: ["Anna", "Jussi"] });
  const tab = getTab(id);
  const pending = [];
  const r = agentTools(tab, "Sami", pending).propose_cover({ person: "Anna" });
  assert.match(r.proposed, /Sami covers Anna's 160\.00 €/, "amount comes from the server, not the model");
  assert.equal(getShares(id).find((s) => s.person === "Anna").status, "open", "nothing changed yet");
  assert.equal((await confirmProposal(id, pending[0].token, "Jussi")).status, 403, "only the organiser confirms");
  assert.equal((await confirmProposal(id, pending[0].token, "Sami")).status, 409, "a token is burnt after one use, even a failed one");

  const again = [];
  agentTools(tab, "Sami", again).propose_cover({ person: "Anna" });
  assert.ok((await confirmProposal(id, again[0].token, "Sami")).view);
  assert.ok(getShares(id).some((s) => s.person === "Sami (for Anna)"), "covered after confirm");
});

test("non-organisers can't propose money moves; nudges only reach people without a hold", () => {
  const { id } = createCheckout({ product: "lakeside-cabin", organiser: "Sami", members: ["Anna"] });
  const pending = [];
  const tools = agentTools(getTab(id), "Anna", pending);
  assert.ok(tools.propose_cancel().error);
  assert.ok(tools.propose_cover({ person: "Sami" }).error);
  assert.equal(pending.length, 0);
  assert.ok(tools.nudge({ person: "Mallory", message: "hi" }).error);
  assert.ok(tools.nudge({ person: "Sami", message: "hurry" }).posted);
});
