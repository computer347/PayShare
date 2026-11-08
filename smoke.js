// Checks sandbox credentials without a browser: gets a token and creates a real sandbox order.
import assert from "node:assert";
import { paypal } from "./server.js";

const order = await paypal("POST", "/v2/checkout/orders", {
  intent: "CAPTURE",
  purchase_units: [{ amount: { currency_code: "EUR", value: "1.00" } }],
});
assert.equal(order.status, "CREATED");
console.log(`OK: sandbox order ${order.id} created. Approve link:`, order.links.find((l) => l.rel === "approve").href);
