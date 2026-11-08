// Money math. All amounts are integer cents, never floats.

// Split `total` cents in proportion to `weights` so the parts always sum to exactly `total`.
// Largest-remainder rounding; ties go to the earlier index, so results are deterministic.
export function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  const order = raw.map((r, i) => [r - out[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const left = total - out.reduce((a, b) => a + b, 0);
  for (let k = 0; k < left; k++) out[order[k][1]]++;
  return out;
}

export const UNCLAIMED = "";

// items: [{id, name, cents}], claims: [{itemId, person}], totalCents: what the payer paid (incl. tip/service).
// Shared items split evenly; extras (total - items) split in proportion to each owner's items,
// where unclaimed items count as their own owner, so your extras never change when others claim.
export function splitTab({ items, claims, totalCents }) {
  const owners = new Map();
  const owner = (k) => owners.get(k) ?? owners.set(k, { items: [], subtotal: 0 }).get(k);
  for (const item of items) {
    const people = [...new Set(claims.filter((c) => c.itemId === item.id).map((c) => c.person))].sort();
    const keys = people.length ? people : [UNCLAIMED];
    allocate(item.cents, keys.map(() => 1)).forEach((cents, i) => {
      const o = owner(keys[i]);
      o.items.push({ itemId: item.id, name: item.name, cents, sharedWith: people.length });
      o.subtotal += cents;
    });
  }
  const keys = [...owners.keys()];
  const itemsCents = items.reduce((a, i) => a + i.cents, 0);
  const extras = allocate(totalCents - itemsCents, keys.map((k) => owners.get(k).subtotal));
  const result = Object.fromEntries(keys.map((k, i) => [k, { ...owners.get(k), extras: extras[i], total: owners.get(k).subtotal + extras[i] }]));
  const sum = Object.values(result).reduce((a, o) => a + o.total, 0);
  if (sum !== totalCents) throw new Error(`split bug: shares sum ${sum} != total ${totalCents}`);
  return result;
}

// Checks AI-extracted receipt numbers before anyone pays. Never trust the model's arithmetic.
export function checkReceipt({ items, subtotalCents, totalCents }) {
  const issues = [];
  const isCents = (v) => Number.isInteger(v) && v >= 0;
  if (!items?.length) issues.push("no items found");
  for (const i of items ?? []) if (!i.name || !isCents(i.cents)) issues.push(`bad item: ${JSON.stringify(i)}`);
  if (!isCents(totalCents)) issues.push("total missing or not a whole number of cents");
  const itemsCents = (items ?? []).reduce((a, i) => a + (i.cents || 0), 0);
  if (subtotalCents != null && subtotalCents !== itemsCents)
    issues.push(`items add up to ${itemsCents} but receipt subtotal says ${subtotalCents} (off by ${subtotalCents - itemsCents})`);
  if (isCents(totalCents) && totalCents < itemsCents) issues.push(`total ${totalCents} is less than the items ${itemsCents}`);
  return { ok: issues.length === 0, issues, itemsCents, extrasCents: (totalCents ?? 0) - itemsCents };
}
