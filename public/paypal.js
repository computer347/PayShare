// Shared PayPal button for the tab and group pages (PayPal JS SDK v6, sandbox):
// https://developer.paypal.com/sdk/js/set-up
// The server decides the amount; the page only says which tab and who is paying.
export async function mountPayPal({ button, tabId, who, say, onDone }) {
  await new Promise((ok, fail) =>
    document.head.append(Object.assign(document.createElement("script"), { src: "https://www.sandbox.paypal.com/web-sdk/v6/core", onload: ok, onerror: fail })),
  );
  const { clientId } = await (await fetch("/config")).json();
  const sdk = await window.paypal.createInstance({ clientId, components: ["paypal-payments"], pageType: "checkout" });
  if (!(await sdk.findEligibleMethods({ currencyCode: "EUR" })).isEligible("paypal")) throw new Error("PayPal isn't available for this payment");
  const session = sdk.createPayPalOneTimePaymentSession({
    async onApprove({ orderId }) {
      say("Confirming with PayPal…");
      const r = await fetch(`/api/orders/${orderId}/complete`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) say(`❌ ${d.error}`);
      onDone?.();
    },
    onCancel: () => say("Cancelled in PayPal. Nothing was paid."),
    onError: (e) => say(`❌ ${e.message ?? e}`),
  });
  button.addEventListener("click", () => {
    say("");
    const order = fetch(`/api/tabs/${tabId}/pay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ person: who() }) })
      .then((r) => r.json())
      .then((d) => { if (!d.id) throw new Error(d.error); return { orderId: d.id }; }); // v6 wants { orderId }
    session.start({ presentationMode: "auto" }, order).catch((e) => say(`❌ ${e.message}`));
  });
}
