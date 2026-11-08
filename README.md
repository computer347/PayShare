# PayShare

*Any bill, any group, one tab.* Snap a receipt, friends tap what they had, everyone pays their part
to whoever paid the bill with PayPal, and a live group feed shows who has actually paid, confirmed by PayPal.

Built for the PayPal AI Hackathon 2026. **PayPal sandbox only.**

## Run locally

Requires Node 24+.

1. Create a sandbox app at [developer.paypal.com](https://developer.paypal.com/dashboard/applications/sandbox)
   and copy `.env.example` to `.env` with its client ID and secret.
2. `npm install`
3. `npm run smoke` creates a sandbox order to check your credentials.
4. `npm start`, open http://localhost:3000 and pay with a sandbox **personal** account
   (Dashboard > Testing Tools > Sandbox Accounts).

## Licence

MIT
