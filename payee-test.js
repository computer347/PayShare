// Answers one architecture question before we build: can our app take payments FOR another
// PayPal account (the friend who paid the bill)? Tests capture-now, hold→capture, hold→void, and Payouts.
// Usage: put PAYEE_EMAIL=<a second sandbox account> in .env, then `npm run payee-test`.
import { paypal } from "./server.js";

const payee = process.env.PAYEE_EMAIL;
if (!payee) throw new Error("Set PAYEE_EMAIL in .env to a sandbox account that is NOT your app's business account");

const step = async (label, fn) => {
  try {
    const r = await fn();
    console.log(`✅ ${label}`);
    return r;
  } catch (e) {
    console.log(`❌ ${label}: ${e.message}\n   ${JSON.stringify(e.data?.details ?? e.data ?? "")}`);
  }
};

// 1. Payouts: our business account pays the payee directly; no buyer approval needed.
await step(`Payouts 1.00 EUR → ${payee}`, () =>
  paypal("POST", "/v1/payments/payouts", {
    sender_batch_header: { sender_batch_id: `payshare-test-${Date.now()}`, email_subject: "PayShare payout test" },
    items: [{ recipient_type: "EMAIL", receiver: payee, amount: { value: "1.00", currency: "EUR" }, note: "PayShare payout test" }],
  }),
);

// 2. Three orders paid straight to the payee.
const order = (intent, label) =>
  paypal("POST", "/v2/checkout/orders", {
    intent,
    purchase_units: [{ amount: { currency_code: "EUR", value: "5.00" }, payee: { email_address: payee }, description: `PayShare test · ${label}` }],
  });
const tests = {
  capture: await step("create CAPTURE order to payee", () => order("CAPTURE", "pay now")),
  holdCapture: await step("create AUTHORIZE order to payee (hold → capture)", () => order("AUTHORIZE", "hold then capture")),
  holdVoid: await step("create AUTHORIZE order to payee (hold → void)", () => order("AUTHORIZE", "hold then release")),
};
const pending = Object.entries(tests).filter(([, o]) => o);
if (!pending.length) process.exit(1);

console.log("\nApprove each of these as your sandbox PERSONAL buyer:");
for (const [name, o] of pending) console.log(`  ${name}: ${o.links.find((l) => l.rel === "approve").href}`);

// 3. Wait for approvals (max 10 min).
const deadline = Date.now() + 10 * 60_000;
for (const [name, o] of pending) {
  while ((await paypal("GET", `/v2/checkout/orders/${o.id}`)).status !== "APPROVED") {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${name} approval`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`   ${name} approved`);
}

// 4. Move the money.
if (tests.capture) await step("capture now → payee", () => paypal("POST", `/v2/checkout/orders/${tests.capture.id}/capture`));
for (const [name, then] of [["holdCapture", "capture"], ["holdVoid", "void"]]) {
  if (!tests[name]) continue;
  const auth = await step(`${name}: place hold`, () => paypal("POST", `/v2/checkout/orders/${tests[name].id}/authorize`));
  const authId = auth?.purchase_units[0].payments.authorizations[0].id;
  if (authId) await step(`${name}: ${then} hold`, () => paypal("POST", `/v2/payments/authorizations/${authId}/${then}`));
}
