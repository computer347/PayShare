import express from "express";
import { db } from "./db.js";
import { splitTab, checkReceipt, UNCLAIMED } from "./split.js";
import { readReceipt, toClaimableItems, geminiConfigured } from "./receipt.js";

const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYEE_EMAIL, PORT = 3000 } = process.env;
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error("Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .env");
  process.exit(1);
}
const API = "https://api-m.sandbox.paypal.com"; // sandbox only, never live

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
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} ${res.status}`), { data });
  return data;
}

// ---- tabs ----
const euros = (cents) => (cents / 100).toFixed(2);
const getTab = (id) => db.prepare("SELECT * FROM tabs WHERE id = ?").get(id);
const getItems = (id) => db.prepare("SELECT id, name, cents FROM items WHERE tab_id = ? ORDER BY id").all(id);
const getClaims = (id) =>
  db.prepare("SELECT c.item_id AS itemId, c.person FROM claims c JOIN items i ON i.id = c.item_id WHERE i.tab_id = ?").all(id);
const getShares = (id) => db.prepare("SELECT * FROM shares WHERE tab_id = ?").all(id);
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
      status: person === tab.organiser ? "organiser" : (shares[person]?.status ?? "open"),
    }));
  return {
    tab: { id: tab.id, title: tab.title, organiser: tab.organiser, totalCents: tab.total_cents },
    items: getItems(tab.id).map((i) => ({ ...i, claimers: claims.filter((c) => c.itemId === i.id).map((c) => c.person) })),
    people,
    unclaimed: s[UNCLAIMED] ?? null,
  };
}

function createTab({ title, organiser, payeeEmail, totalCents, subtotalCents, items }) {
  const check = checkReceipt({ items, subtotalCents, totalCents });
  if (!check.ok) return { error: "receipt does not add up", issues: check.issues };
  if (!title || !organiser || !/^\S+@\S+$/.test(payeeEmail ?? "")) return { error: "title, organiser and payeeEmail are required" };
  const id = crypto.randomUUID().slice(0, 8);
  db.prepare("INSERT INTO tabs (id, title, organiser, payee_email, total_cents) VALUES (?, ?, ?, ?, ?)").run(id, title, organiser, payeeEmail, totalCents);
  const ins = db.prepare("INSERT INTO items (tab_id, name, cents) VALUES (?, ?, ?)");
  for (const i of items) ins.run(id, String(i.name).slice(0, 100), i.cents);
  return { id };
}

const isPerson = (p) => typeof p === "string" && p.trim().length > 0 && p.length <= 40;
const app = express();
app.use(express.json({ limit: "8mb" })); // receipt photos arrive as base64, downscaled in the browser
app.use(express.static("public"));

// demoPayee pre-fills the organiser's sandbox PayPal email on the new-tab page.
app.get("/config", (_req, res) => res.json({ clientId: PAYPAL_CLIENT_ID, demoPayee: PAYEE_EMAIL ?? "" }));

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
app.post("/api/receipts/read", async (req, res, next) => {
  try {
    const { mediaType, data } = req.body ?? {};
    if (!IMAGE_TYPES.includes(mediaType) || typeof data !== "string" || !data) return res.status(400).json({ error: "send a JPEG, PNG, WebP or GIF image" });
    if (!geminiConfigured()) return res.status(500).json({ error: "set GOOGLE_CLOUD_PROJECT (Vertex AI) or GEMINI_API_KEY in .env" });
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
  if (!PAYEE_EMAIL) return res.status(500).json({ error: "set PAYEE_EMAIL in .env (sandbox account of the person who paid)" });
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

app.get("/api/tabs/:id", (req, res) => {
  const tab = getTab(req.params.id);
  tab ? res.json(view(tab)) : res.status(404).json({ error: "no such tab" });
});

app.put("/api/tabs/:id/claims", (req, res) => {
  const tab = getTab(req.params.id);
  const { itemId, person, claimed } = req.body;
  if (!tab) return res.status(404).json({ error: "no such tab" });
  if (!isPerson(person)) return res.status(400).json({ error: "person name required (max 40 chars)" });
  if (!getItems(tab.id).some((i) => i.id === itemId)) return res.status(400).json({ error: "item not on this tab" });
  // Once someone has paid, their items are frozen: otherwise their share would change after the money moved.
  const paid = new Set(getShares(tab.id).filter((s) => s.status !== "open").map((s) => s.person));
  const claimers = getClaims(tab.id).filter((c) => c.itemId === itemId).map((c) => c.person);
  if (paid.has(person) || claimers.some((p) => paid.has(p))) return res.status(409).json({ error: "already paid for, can't change" });
  if (claimed) db.prepare("INSERT OR IGNORE INTO claims (item_id, person) VALUES (?, ?)").run(itemId, person);
  else db.prepare("DELETE FROM claims WHERE item_id = ? AND person = ?").run(itemId, person);
  res.json(view(tab));
});

// Creates the PayPal order for one person's share, paid straight to the organiser.
app.post("/api/tabs/:id/pay", async (req, res, next) => {
  try {
    const tab = getTab(req.params.id);
    const { person } = req.body;
    if (!tab) return res.status(404).json({ error: "no such tab" });
    if (person === tab.organiser) return res.status(400).json({ error: "the organiser already paid the bill" });
    const mine = split(tab)[person];
    if (!isPerson(person) || !mine?.total) return res.status(400).json({ error: "claim something first" });
    const existing = db.prepare("SELECT * FROM shares WHERE tab_id = ? AND person = ?").get(tab.id, person);
    if (existing && existing.status !== "open") return res.status(409).json({ error: "already paid" });
    if (existing?.order_id && existing.cents === mine.total) return res.json({ id: existing.order_id });

    const lines = mine.items.map((i) => ({ name: i.sharedWith > 1 ? `${i.name} (1/${i.sharedWith})` : i.name, cents: i.cents }));
    if (mine.extras) lines.push({ name: "Tip & service share", cents: mine.extras });
    const order = await paypal(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: `${tab.id}:${person}`.slice(0, 256),
            description: `PayShare · ${tab.title} · ${person} pays ${tab.organiser}`.slice(0, 127),
            payee: { email_address: tab.payee_email },
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

app.post("/api/orders/:id/capture", async (req, res, next) => {
  try {
    const share = db.prepare("SELECT * FROM shares WHERE order_id = ?").get(req.params.id);
    if (!share) return res.status(404).json({ error: "unknown order" });
    if (share.status !== "open") return res.json({ status: share.status });
    // Claims may have changed between creating the order and approving it: never capture a stale amount.
    if (split(getTab(share.tab_id))[share.person]?.total !== share.cents)
      return res.status(409).json({ error: "your part changed since you started paying, please pay again" });
    const r = await paypal("POST", `/v2/checkout/orders/${encodeURIComponent(share.order_id)}/capture`, undefined, `${share.order_id}-capture`);
    const cap = r.purchase_units?.[0]?.payments?.captures?.[0];
    if (r.status !== "COMPLETED" || !cap) return res.status(402).json({ error: `payment not completed (${cap?.status ?? r.status})` });
    db.prepare("UPDATE shares SET status = 'confirming', capture_id = ? WHERE order_id = ?").run(cap.id, share.order_id);
    res.json({ status: "confirming", captureId: cap.id });
  } catch (e) { next(e); }
});

app.use((err, _req, res, _next) => {
  console.error(err.message, JSON.stringify(err.data ?? ""));
  res.status(500).json({ error: err.message, details: err.data });
});

if (process.argv[1].endsWith("server.js")) app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
