import express from "express";
import { db } from "./db.js";
import { splitTab, checkReceipt, allocate, UNCLAIMED } from "./split.js";
import { readReceipt, toClaimableItems, geminiConfigured } from "./receipt.js";

const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYEE_EMAIL, PORT = 3000 } = process.env;
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error("Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .env");
  process.exit(1);
}
const API = "https://api-m.sandbox.paypal.com"; // sandbox only, never live
const CHECKOUT_MINUTES = Number(process.env.CHECKOUT_MINUTES ?? 15);

async function accessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${API}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token; // shortcut: new token per call, cache it once traffic matters
}

// requestId makes PayPal treat retries of the same action as one action (no double orders/captures).
export async function paypal(method, path, body, requestId = crypto.randomUUID()) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", "PayPal-Request-Id": requestId },
    body: body && JSON.stringify(body),
  });
  const data = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} ${res.status}`), { data });
  return data;
}
let call = paypal; // the money-moving code below goes through `call` so tests can stand in for PayPal
export const usePayPalForTests = (fn) => (call = fn);
const reason = (e) => e.data?.details?.[0]?.issue ?? e.data?.name ?? e.message;

// ---- tabs ----
const euros = (cents) => (cents / 100).toFixed(2);
const getTab = (id) => db.prepare("SELECT * FROM tabs WHERE id = ?").get(id);
const getItems = (id) => db.prepare("SELECT id, name, cents FROM items WHERE tab_id = ? ORDER BY id").all(id);
const getClaims = (id) =>
  db.prepare("SELECT c.item_id AS itemId, c.person FROM claims c JOIN items i ON i.id = c.item_id WHERE i.tab_id = ?").all(id);
const getShares = (id) => db.prepare("SELECT * FROM shares WHERE tab_id = ? ORDER BY rowid").all(id);
const getShare = (orderId) => db.prepare("SELECT * FROM shares WHERE order_id = ?").get(orderId);
const setShare = (sql, ...args) => db.prepare(`UPDATE shares SET ${sql}`).run(...args).changes > 0;
const setTab = (id, from, to) => db.prepare("UPDATE tabs SET status = ? WHERE id = ? AND status = ?").run(to, id, from).changes > 0;
const split = (tab) => splitTab({ items: getItems(tab.id), claims: getClaims(tab.id), totalCents: tab.total_cents });

function view(tab) {
  const s = split(tab);
  const shares = Object.fromEntries(getShares(tab.id).map((r) => [r.person, r]));
  const claims = getClaims(tab.id);
  const people = Object.entries(s)
    .filter(([p]) => p !== UNCLAIMED)
    .map(([person, o]) => ({
      person,
      cents: o.total,
      extras: o.extras,
      items: o.items,
      status: tab.mode === "receipt" && person === tab.organiser ? "organiser" : (shares[person]?.status ?? "open"),
    }));
  return {
    tab: {
      id: tab.id, mode: tab.mode, title: tab.title, organiser: tab.organiser, merchant: tab.merchant,
      totalCents: tab.total_cents, status: tab.status, expiresAt: tab.expires_at,
    },
    items: getItems(tab.id).map((i) => ({ ...i, claimers: claims.filter((c) => c.itemId === i.id).map((c) => c.person) })),
    people,
    unclaimed: s[UNCLAIMED] ?? null,
    feed: db.prepare("SELECT text, at FROM feed WHERE tab_id = ? ORDER BY id DESC LIMIT 30").all(tab.id),
  };
}

// ---- live updates: every open tab page holds a Server-Sent Events stream ----
const streams = new Map(); // tabId -> Set of open responses
function publish(tabId) {
  const tab = getTab(tabId);
  const msg = `data: ${JSON.stringify(view(tab))}\n\n`;
  for (const res of streams.get(tabId) ?? []) res.write(msg);
}
// Keeps idle connections open through proxies (Render closes silent ones).
setInterval(() => { for (const set of streams.values()) for (const res of set) res.write(": ping\n\n"); }, 25_000).unref();

const post = (tabId, text) => db.prepare("INSERT INTO feed (tab_id, text) VALUES (?, ?)").run(tabId, text);
const describe = (share) => {
  const mine = split(getTab(share.tab_id))[share.person];
  const what = mine?.items.map((i) => (i.sharedWith > 1 ? `${i.name} (1/${i.sharedWith})` : i.name)).join(", ");
  return `${share.person}: ${euros(share.cents)} €${what ? ` (${what})` : ""}`;
};

function insertTab({ mode = "receipt", title, organiser, payeeEmail, merchant = null, totalCents, expiresAt = null, items }) {
  const id = crypto.randomUUID().slice(0, 8);
  db.prepare("INSERT INTO tabs (id, mode, title, organiser, payee_email, merchant, total_cents, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, mode, title, organiser, payeeEmail, merchant, totalCents, expiresAt);
  const ins = db.prepare("INSERT INTO items (tab_id, name, cents) VALUES (?, ?, ?)");
  return { id, itemIds: items.map((i) => ins.run(id, String(i.name).slice(0, 100), i.cents).lastInsertRowid) };
}

function createTab({ title, organiser, payeeEmail, totalCents, subtotalCents, items }) {
  const check = checkReceipt({ items, subtotalCents, totalCents });
  if (!check.ok) return { error: "receipt does not add up", issues: check.issues };
  if (!title || !organiser || !/^\S+@\S+$/.test(payeeEmail ?? "")) return { error: "title, organiser and payeeEmail are required" };
  return { id: insertTab({ title, organiser, payeeEmail, totalCents, items }).id };
}

// ---- money: Payouts from PayShare's account ----
async function payout({ batchId, email, cents, note }) {
  return call("POST", "/v1/payments/payouts", {
    sender_batch_header: { sender_batch_id: batchId, email_subject: "You've received money via PayShare" },
    items: [{ recipient_type: "EMAIL", receiver: email, amount: { value: euros(cents), currency: "EUR" }, note, sender_item_id: batchId }],
  }, batchId);
}

// Receipt split: once PayPal confirms a share, forward it to the organiser. The batch id is claimed in the
// database first, so a repeated webhook or a crash-and-retry can never pay the organiser twice.
async function payOutShare(orderId) {
  const share = getShare(orderId);
  const tab = getTab(share.tab_id);
  const batchId = `share-${share.capture_id}`;
  if (!setShare("payout_batch_id = ? WHERE order_id = ? AND payout_batch_id IS NULL", batchId, orderId)) return;
  try {
    const r = await payout({ batchId, email: tab.payee_email, cents: share.cents, note: `${share.person}'s part of ${tab.title}` });
    post(tab.id, `💸 Sending ${euros(share.cents)} € on to ${tab.organiser}…`);
    publish(tab.id);
    watchPayout(tab, share, r.batch_header.payout_batch_id);
  } catch (e) {
    console.error("payout failed", reason(e));
    post(tab.id, `⚠️ Couldn't forward ${share.person}'s ${euros(share.cents)} € to ${tab.organiser} yet (${reason(e)})`);
    publish(tab.id);
  }
}

// A payout is only "sent" once its item says SUCCESS: a new batch is PENDING, and an email without a
// PayPal account leaves it UNCLAIMED. Checks every 5 s for up to 2 minutes.
async function watchPayout(tab, share, payoutBatchId, tries = 24) {
  await new Promise((r) => setTimeout(r, 5000));
  try {
    const item = (await call("GET", `/v1/payments/payouts/${payoutBatchId}`)).items?.[0];
    const status = item?.transaction_status;
    if (status === "SUCCESS") post(tab.id, `💸 ${tab.organiser} received ${euros(share.cents)} € (${share.person}'s part)`);
    else if (["UNCLAIMED", "FAILED", "RETURNED", "BLOCKED", "DENIED"].includes(status))
      post(tab.id, `⚠️ Payout of ${share.person}'s part to ${tab.organiser} is ${status.toLowerCase()}${status === "UNCLAIMED" ? " (no PayPal account on that email yet)" : ""}`);
    else if (tries > 1) return watchPayout(tab, share, payoutBatchId, tries - 1);
    publish(tab.id);
  } catch (e) {
    console.error("payout status", reason(e));
  }
}

// ---- group checkout: all holds captured, or all released ----
const allIn = (tabId) => getShares(tabId).every((s) => s.status === "held");

async function settle(tabId) {
  if (!setTab(tabId, "open", "settling")) return; // only one caller ever settles a tab
  const tab = getTab(tabId);
  post(tabId, "🙌 Everyone's in. Taking the money from every hold…");
  publish(tabId);
  const captured = [];
  for (const s of getShares(tabId)) {
    try {
      const cap = await call("POST", `/v2/payments/authorizations/${s.authorization_id}/capture`, {}, `${s.authorization_id}-capture`);
      if (cap.status !== "COMPLETED" && cap.status !== "PENDING") throw Object.assign(new Error(cap.status), { data: { name: cap.status } });
      setShare("status = 'confirming', capture_id = ? WHERE order_id = ? AND status = 'held'", cap.id, s.order_id);
      captured.push({ ...s, capture_id: cap.id });
    } catch (e) {
      return rollBack(tab, s, captured, e);
    }
  }
  // The merchant runs the "Pay as a group" button on its own PayPal account, so capturing the holds is the payment.
  setTab(tabId, "settling", "booked");
  post(tabId, `🏡 Booked! ${tab.merchant} received ${euros(tab.total_cents)} € from ${captured.length} people.`);
  publish(tabId);
}

// Partial failure: one capture failed after others succeeded. Refund what was taken, release the rest.
async function rollBack(tab, failed, captured, err) {
  post(tab.id, `❌ PayPal couldn't take ${failed.person}'s share (${reason(err)}). Cancelling the booking for everyone.`);
  for (const c of captured) {
    try {
      await call("POST", `/v2/payments/captures/${c.capture_id}/refund`, {}, `${c.capture_id}-refund`);
      setShare("status = 'refunded' WHERE order_id = ?", c.order_id);
    } catch (e) {
      post(tab.id, `⚠️ Refund to ${c.person} failed (${reason(e)}); support will refund manually.`);
    }
  }
  await voidHolds(tab.id);
  db.prepare("UPDATE tabs SET status = 'failed' WHERE id = ?").run(tab.id);
  post(tab.id, "↩️ Everyone got their money back. Nobody paid for a booking that didn't happen.");
  publish(tab.id);
}

async function voidHolds(tabId) {
  for (const s of getShares(tabId).filter((s) => s.status === "held")) {
    try {
      await call("POST", `/v2/payments/authorizations/${s.authorization_id}/void`, {}, `${s.authorization_id}-void`);
      setShare("status = 'released' WHERE order_id = ? AND status = 'held'", s.order_id);
    } catch (e) {
      post(tabId, `⚠️ Couldn't release ${s.person}'s hold (${reason(e)}); PayPal releases it automatically when it expires.`);
    }
  }
}

async function release(tabId, why) {
  if (!setTab(tabId, "open", "releasing")) return;
  post(tabId, why);
  publish(tabId);
  await voidHolds(tabId);
  setTab(tabId, "releasing", "released");
  post(tabId, "↩️ All holds released. Nobody was charged.");
  publish(tabId);
}

// The 15-minute clock: release every hold on checkouts that ran out of time.
const expired = () => db.prepare("SELECT id FROM tabs WHERE mode = 'checkout' AND status = 'open' AND expires_at < ?").all(new Date().toISOString());
export const releaseExpired = () => Promise.all(expired().map((t) => release(t.id, "⏰ Time's up: not everyone joined in time.")));
setInterval(() => releaseExpired().catch((e) => console.error("expiry", e.message)), 5000).unref();

// The mock merchant's catalogue lives on the server: the browser never decides prices or who gets paid.
const CATALOGUE = {
  "lakeside-cabin": { merchant: "Lakeside Cabins", title: "Lakeside Cabins · sauna cabin, Fri–Sun", cents: 48000 },
};

const isPerson = (p) => typeof p === "string" && p.trim().length > 0 && p.length <= 40;
const app = express();
// Receipt photos arrive as base64 (downscaled in the browser). rawBody is kept for webhook signature checks.
app.use(express.json({ limit: "8mb", verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));
app.use(express.static("public"));

// demoPayee pre-fills the organiser's sandbox PayPal email on the new-tab page.
app.get("/config", (_req, res) => res.json({ clientId: PAYPAL_CLIENT_ID, demoPayee: PAYEE_EMAIL ?? "" }));

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
app.post("/api/receipts/read", async (req, res, next) => {
  try {
    const { mediaType, data } = req.body ?? {};
    if (!IMAGE_TYPES.includes(mediaType) || typeof data !== "string" || !data) return res.status(400).json({ error: "send a JPEG, PNG, WebP or GIF image" });
    if (!geminiConfigured()) return res.status(500).json({ error: "set VERTEX_API_KEY, GOOGLE_CLOUD_PROJECT or GEMINI_API_KEY" });
    const r = await readReceipt({ mediaType, data });
    const items = toClaimableItems(r);
    res.json({
      merchant: r.merchant,
      currency: r.currency,
      items,
      subtotalCents: r.subtotal_cents,
      totalCents: r.total_cents,
      check: checkReceipt({ items, subtotalCents: r.subtotal_cents, totalCents: r.total_cents }),
    });
  } catch (e) { next(e); }
});

app.post("/api/tabs", (req, res) => {
  const r = createTab(req.body);
  res.status(r.error ? 400 : 201).json(r);
});

// The dinner from the pitch, paid by Sami; judges can try the flow without a receipt.
app.post("/api/demo", (_req, res) => {
  if (!PAYEE_EMAIL) return res.status(500).json({ error: "set PAYEE_EMAIL (sandbox account of the person who paid)" });
  res.status(201).json(
    createTab({
      title: "Dinner at Ravintola Demo",
      organiser: "Sami",
      payeeEmail: PAYEE_EMAIL,
      totalCents: 8910,
      subtotalCents: 8100,
      items: [
        { name: "Steak", cents: 3000 },
        { name: "Pasta", cents: 1800 },
        { name: "Wine (bottle)", cents: 2400 },
        { name: "Tiramisu", cents: 900 },
      ],
    }),
  );
});

// "Pay as a group" from the merchant's checkout: one equal share per person, a 15-minute clock.
// In this demo PayShare's own sandbox account plays the merchant (Lakeside Cabins), so holds sit with the merchant.
export function createCheckout({ product, organiser, members }) {
  const p = CATALOGUE[product];
  if (!p) return { error: "unknown product" };
  const people = [...new Set([organiser, ...(members ?? [])].map((m) => String(m ?? "").trim()).filter(Boolean))];
  if (!isPerson(organiser) || people.length < 2 || people.length > 10 || !people.every(isPerson)) return { error: "add 1 to 9 friends by name" };
  const cents = allocate(p.cents, people.map(() => 1));
  const expiresAt = new Date(Date.now() + CHECKOUT_MINUTES * 60_000).toISOString();
  const { id, itemIds } = insertTab({
    mode: "checkout", title: p.title, organiser: organiser.trim(), payeeEmail: null, merchant: p.merchant,
    totalCents: p.cents, expiresAt, items: people.map((person, i) => ({ name: `${person}'s share`, cents: cents[i] })),
  });
  people.forEach((person, i) => {
    db.prepare("INSERT INTO claims (item_id, person) VALUES (?, ?)").run(itemIds[i], person);
    db.prepare("INSERT INTO shares (tab_id, person, cents) VALUES (?, ?, ?)").run(id, person, cents[i]);
  });
  post(id, `🛒 ${organiser.trim()} started a group checkout: ${euros(p.cents)} € split ${people.length} ways. Everyone has ${CHECKOUT_MINUTES} minutes.`);
  return { id };
}

app.post("/api/checkouts", (req, res) => {
  const r = createCheckout(req.body ?? {});
  res.status(r.error ? 400 : 201).json(r);
});

app.get("/api/tabs/:id", (req, res) => {
  const tab = getTab(req.params.id);
  tab ? res.json(view(tab)) : res.status(404).json({ error: "no such tab" });
});

app.put("/api/tabs/:id/claims", (req, res) => {
  const tab = getTab(req.params.id);
  const { itemId, person, claimed } = req.body;
  if (!tab) return res.status(404).json({ error: "no such tab" });
  if (tab.mode !== "receipt") return res.status(400).json({ error: "shares in a group checkout are fixed" });
  if (!isPerson(person)) return res.status(400).json({ error: "person name required (max 40 chars)" });
  if (!getItems(tab.id).some((i) => i.id === itemId)) return res.status(400).json({ error: "item not on this tab" });
  // Once someone has paid, their items are frozen: otherwise their share would change after the money moved.
  const paid = new Set(getShares(tab.id).filter((s) => s.status !== "open").map((s) => s.person));
  const claimers = getClaims(tab.id).filter((c) => c.itemId === itemId).map((c) => c.person);
  if (paid.has(person) || claimers.some((p) => paid.has(p))) return res.status(409).json({ error: "already paid for, can't change" });
  if (claimed) db.prepare("INSERT OR IGNORE INTO claims (item_id, person) VALUES (?, ?)").run(itemId, person);
  else db.prepare("DELETE FROM claims WHERE item_id = ? AND person = ?").run(itemId, person);
  res.json(view(tab));
  publish(tab.id);
});

app.get("/api/tabs/:id/events", (req, res) => {
  const tab = getTab(req.params.id);
  if (!tab) return res.status(404).end();
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(`data: ${JSON.stringify(view(tab))}\n\n`);
  const set = streams.get(tab.id) ?? streams.set(tab.id, new Set()).get(tab.id);
  set.add(res);
  req.on("close", () => set.delete(res));
});

const isOpenCheckout = (tab) => tab.status === "open" && new Date(tab.expires_at) > new Date();

// Creates the PayPal order for one person's share, paid to PayShare's account.
// Receipt: captured right away. Checkout: only a hold (AUTHORIZE) until everyone is in.
app.post("/api/tabs/:id/pay", async (req, res, next) => {
  try {
    const tab = getTab(req.params.id);
    const { person } = req.body;
    if (!tab) return res.status(404).json({ error: "no such tab" });
    const checkout = tab.mode === "checkout";
    if (checkout && !isOpenCheckout(tab)) return res.status(409).json({ error: "this group checkout is closed" });
    if (!checkout && person === tab.organiser) return res.status(400).json({ error: "the organiser already paid the bill" });
    const mine = split(tab)[person];
    if (!isPerson(person) || !mine?.total) return res.status(400).json({ error: checkout ? "pick your name first" : "claim something first" });
    const existing = db.prepare("SELECT * FROM shares WHERE tab_id = ? AND person = ?").get(tab.id, person);
    if (existing && existing.status !== "open") return res.status(409).json({ error: "already paid" });
    if (existing?.order_id && existing.cents === mine.total) return res.json({ id: existing.order_id });

    const lines = mine.items.map((i) => ({ name: i.sharedWith > 1 ? `${i.name} (1/${i.sharedWith})` : i.name, cents: i.cents }));
    if (mine.extras) lines.push({ name: "Tip & service share", cents: mine.extras });
    const order = await paypal(
      "POST",
      "/v2/checkout/orders",
      {
        intent: checkout ? "AUTHORIZE" : "CAPTURE",
        purchase_units: [
          {
            reference_id: `${tab.id}:${person}`.slice(0, 256),
            description: (checkout ? `PayShare · ${tab.title} · ${person}'s share (hold)` : `PayShare · ${tab.title} · ${person} pays ${tab.organiser}`).slice(0, 127),
            amount: { currency_code: "EUR", value: euros(mine.total), breakdown: { item_total: { currency_code: "EUR", value: euros(mine.total) } } },
            items: lines.map((l) => ({ name: l.name.slice(0, 127), quantity: "1", unit_amount: { currency_code: "EUR", value: euros(l.cents) } })),
          },
        ],
      },
      `${tab.id}-${person}-${mine.total}-create`,
    );
    db.prepare(
      `INSERT INTO shares (tab_id, person, cents, order_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (tab_id, person) DO UPDATE SET cents = excluded.cents, order_id = excluded.order_id`,
    ).run(tab.id, person, mine.total, order.id);
    res.json({ id: order.id });
  } catch (e) { next(e); }
});

// After the buyer approves in PayPal: capture (receipt) or place the hold (checkout).
app.post("/api/orders/:id/complete", async (req, res, next) => {
  try {
    const share = getShare(req.params.id);
    if (!share) return res.status(404).json({ error: "unknown order" });
    if (share.status !== "open") return res.json({ status: share.status });
    const tab = getTab(share.tab_id);
    return tab.mode === "checkout" ? res.json(await placeHold(tab, share)) : res.json(await captureShare(tab, share));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

const fail = (status, message) => Object.assign(new Error(message), { status });

async function captureShare(tab, share) {
  // Claims may have changed between creating the order and approving it: never capture a stale amount.
  if (split(tab)[share.person]?.total !== share.cents) throw fail(409, "your part changed since you started paying, please pay again");
  const r = await paypal("POST", `/v2/checkout/orders/${encodeURIComponent(share.order_id)}/capture`, undefined, `${share.order_id}-capture`);
  const cap = r.purchase_units?.[0]?.payments?.captures?.[0];
  if (r.status !== "COMPLETED" || !cap) throw fail(402, `payment not completed (${cap?.status ?? r.status})`);
  // Forward-only: if PayPal's webhook already marked it paid, don't step back to confirming.
  if (setShare("status = 'confirming', capture_id = ? WHERE order_id = ? AND status = 'open'", cap.id, share.order_id))
    post(tab.id, `💳 ${describe(share)}, confirming with PayPal…`);
  publish(tab.id);
  return { status: "confirming" };
}

async function placeHold(tab, share) {
  if (!isOpenCheckout(tab)) throw fail(409, "this group checkout closed before your hold; you were not charged");
  const r = await paypal("POST", `/v2/checkout/orders/${encodeURIComponent(share.order_id)}/authorize`, undefined, `${share.order_id}-authorize`);
  const auth = r.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!auth || auth.status !== "CREATED") throw fail(402, `hold not placed (${auth?.status ?? r.status})`);
  setShare("status = 'held', authorization_id = ? WHERE order_id = ? AND status = 'open'", auth.id, share.order_id);
  // The clock may have run out or someone cancelled while PayPal was answering: release this hold too.
  if (getTab(tab.id).status !== "open") {
    await voidHolds(tab.id);
    publish(tab.id);
    throw fail(409, "this group checkout closed while your hold was placed; it was released");
  }
  post(tab.id, `🔒 ${share.person}'s ${euros(share.cents)} € is on hold. Not charged yet.`);
  publish(tab.id);
  if (allIn(tab.id)) settle(tab.id).catch((e) => console.error("settle", e));
  return { status: "held" };
}

// Someone drops out: the organiser can cover their share (and settle with them later) or cancel for all.
app.post("/api/tabs/:id/out", (req, res) => {
  const tab = getTab(req.params.id);
  const { person } = req.body ?? {};
  if (!tab || tab.mode !== "checkout" || !isOpenCheckout(tab)) return res.status(409).json({ error: "this group checkout is closed" });
  if (!setShare("status = 'out' WHERE tab_id = ? AND person = ? AND status = 'open'", tab.id, person)) return res.status(409).json({ error: "only someone who hasn't paid can drop out" });
  post(tab.id, `🚪 ${person} is out. ${tab.organiser}: cover ${person}'s share, or cancel for everyone?`);
  publish(tab.id);
  res.json(view(tab));
});

app.post("/api/tabs/:id/cover", (req, res) => {
  const tab = getTab(req.params.id);
  const { person } = req.body ?? {};
  if (!tab || tab.mode !== "checkout" || !isOpenCheckout(tab)) return res.status(409).json({ error: "this group checkout is closed" });
  const share = db.prepare("SELECT * FROM shares WHERE tab_id = ? AND person = ? AND status = 'out'").get(tab.id, person);
  if (!share) return res.status(409).json({ error: "nobody to cover" });
  const coverer = `${tab.organiser} (for ${person})`;
  db.prepare("UPDATE claims SET person = ? WHERE person = ? AND item_id IN (SELECT id FROM items WHERE tab_id = ?)").run(coverer, person, tab.id);
  db.prepare("UPDATE shares SET person = ?, status = 'open', order_id = NULL WHERE tab_id = ? AND person = ?").run(coverer, tab.id, person);
  post(tab.id, `🤝 ${tab.organiser} covers ${person}'s ${euros(share.cents)} €. ${person} can pay ${tab.organiser} back later.`);
  publish(tab.id);
  res.json(view(tab));
});

app.post("/api/tabs/:id/cancel", async (req, res) => {
  const tab = getTab(req.params.id);
  if (!tab || tab.mode !== "checkout") return res.status(404).json({ error: "no such group checkout" });
  await release(tab.id, `🛑 ${tab.organiser} cancelled the group checkout.`);
  res.json(view(getTab(tab.id)));
});

// ---- PayPal webhooks: the source of truth for "paid" ----
// Signature check happens at PayPal: we send back the exact bytes we received.
async function verifyWebhook(req) {
  const h = (n) => req.get(n);
  const body =
    `{"auth_algo":${JSON.stringify(h("paypal-auth-algo"))},"cert_url":${JSON.stringify(h("paypal-cert-url"))},` +
    `"transmission_id":${JSON.stringify(h("paypal-transmission-id"))},"transmission_sig":${JSON.stringify(h("paypal-transmission-sig"))},` +
    `"transmission_time":${JSON.stringify(h("paypal-transmission-time"))},"webhook_id":${JSON.stringify(process.env.PAYPAL_WEBHOOK_ID)},` +
    `"webhook_event":${req.rawBody}}`;
  const res = await fetch(`${API}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body,
  });
  return res.ok && (await res.json()).verification_status === "SUCCESS";
}

app.post("/api/paypal/webhook", async (req, res, next) => {
  try {
    if (!process.env.PAYPAL_WEBHOOK_ID) return res.status(500).json({ error: "PAYPAL_WEBHOOK_ID not set" });
    const verified = await verifyWebhook(req);
    console.log(`webhook ${req.body?.event_type} ${req.body?.id} verified=${verified}`);
    if (!verified) return res.status(400).json({ error: "signature check failed" });
    const { share, paidNow } = handleEvent(req.body);
    if (share) publish(share.tab_id);
    res.sendStatus(200);
    if (paidNow && getTab(share.tab_id).mode === "receipt") payOutShare(share.order_id).catch((e) => console.error("payout", e));
  } catch (e) { next(e); }
});

// One transaction: the event id is only recorded together with its effect, so a crash halfway
// leaves nothing recorded and PayPal's retry processes it again. Repeats of a done event are ignored.
export function handleEvent(event) {
  db.exec("BEGIN");
  try {
    const result = applyEvent(event);
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function applyEvent(event) {
  const none = { share: null, paidNow: false };
  if (!db.prepare("INSERT OR IGNORE INTO webhook_events (id, type) VALUES (?, ?)").run(event.id, event.event_type).changes) return none;
  const orderId = event.resource?.supplementary_data?.related_ids?.order_id;
  const share = orderId && getShare(orderId);
  if (!share) return none; // not one of ours (e.g. the hello-world or payee tests)
  let paidNow = false;
  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    paidNow = setShare("status = 'paid', capture_id = ? WHERE order_id = ? AND status IN ('open', 'confirming')", event.resource.id, orderId);
    if (paidNow) {
      post(share.tab_id, `✅ PayPal confirmed ${describe(share)}`);
      const v = view(getTab(share.tab_id));
      const settled = v.people.every((p) => ["paid", "organiser"].includes(p.status)) && !v.unclaimed;
      if (settled && v.tab.mode === "receipt") post(share.tab_id, `🎉 Everyone has paid ${v.tab.organiser} back. Tab settled.`);
    }
  } else if (["PAYMENT.CAPTURE.DECLINED", "PAYMENT.CAPTURE.DENIED"].includes(event.event_type)) {
    if (setShare("status = 'open', capture_id = NULL WHERE order_id = ? AND status = 'confirming'", orderId))
      post(share.tab_id, `❌ ${share.person}'s payment was declined by PayPal. Their part is open again.`);
  }
  return { share, paidNow };
}

app.use((err, _req, res, _next) => {
  console.error(err.message, JSON.stringify(err.data ?? ""));
  res.status(500).json({ error: err.message, details: err.data });
});

if (process.argv[1].endsWith("server.js")) app.listen(PORT, () => console.log(`http://localhost:${PORT}`));

export { db, settle, release, getTab, getShares };
