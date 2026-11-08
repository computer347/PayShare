// Registers PayShare's webhook with the sandbox app and prints the id for PAYPAL_WEBHOOK_ID.
// Usage: npm run webhook -- https://payshare.onrender.com
import { paypal } from "./server.js";

const base = process.argv[2];
if (!/^https:\/\//.test(base ?? "")) throw new Error("pass the public https URL of the app, e.g. https://payshare.onrender.com");
const url = new URL("/api/paypal/webhook", base).href;
const events = [
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.AUTHORIZATION.CREATED", // group-checkout holds (next step)
  "PAYMENT.AUTHORIZATION.VOIDED",
];

const existing = (await paypal("GET", "/v1/notifications/webhooks")).webhooks.find((w) => w.url === url);
const hook = existing ?? (await paypal("POST", "/v1/notifications/webhooks", { url, event_types: events.map((name) => ({ name })) }));
console.log(`${existing ? "Already registered" : "Registered"}: ${url}\nPAYPAL_WEBHOOK_ID=${hook.id}`);
