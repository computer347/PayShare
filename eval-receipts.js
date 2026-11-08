// Measures receipt reading against hand-labelled receipts (CVAT annotations.xml: shop / item / total).
// Usage: npm run eval -- receipts   (folder with annotations.xml and images/)
// Reports per receipt: does our own total check pass, does the AI total match the labelled total,
// and how many item lines it found vs the label. Results also go to <folder>/results.json.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readReceipt, toClaimableItems } from "./receipt.js";
import { checkReceipt } from "./split.js";

const dir = process.argv[2] ?? "receipts";
const xml = readFileSync(join(dir, "annotations.xml"), "utf8");
// Last amount in a label: "TOTAL $38.68" -> 3868; whole-unit currencies like "TOTAL 175, 000" -> 17500000.
const cents = (s) => {
  const dec = s.replace(/,/g, "").match(/(\d+\.\d{2})(?!.*\d+\.\d{2})/);
  if (dec) return Math.round(Number(dec[1]) * 100);
  const whole = s.match(/(\d[\d, ]*\d|\d)\s*$/);
  return whole ? Number(whole[1].replace(/[, ]/g, "")) * 100 : null;
};

const truth = [...xml.matchAll(/<image id="(\d+)" name="([^"]+)"[\s\S]*?<\/image>/g)].map(([block, id, name]) => {
  const texts = (label) => [...block.matchAll(new RegExp(`label="${label}"[\\s\\S]*?<attribute name="text">([^<]*)`, "g"))].map((m) => m[1]);
  return { id, name, shop: texts("shop")[0] ?? "", totals: texts("total").map(cents).filter((v) => v != null), items: texts("item").length };
});

const results = [];
for (const t of truth) {
  const ext = t.name.split(".").pop().toLowerCase();
  const mediaType = ext === "png" ? "image/png" : "image/jpeg";
  const t0 = Date.now();
  try {
    const r = await readReceipt({ mediaType, data: readFileSync(join(dir, t.name)).toString("base64") });
    const rows = toClaimableItems(r);
    const check = checkReceipt({ items: rows, subtotalCents: r.subtotal_cents, totalCents: r.total_cents });
    const row = {
      id: t.id, shop: t.shop, ms: Date.now() - t0,
      selfCheck: check.ok, issues: check.issues,
      totalMatch: t.totals.includes(r.total_cents), aiTotal: r.total_cents, labelTotals: t.totals,
      aiLines: r.items.length, labelLines: t.items,
    };
    results.push(row);
    console.log(`${t.id.padStart(2)} ${row.selfCheck ? "✅" : "⚠️ "} check  ${row.totalMatch ? "✅" : "❌"} total ${r.total_cents} vs ${t.totals.join("/")}  lines ${r.items.length}/${t.items}  ${t.shop.slice(0, 20)}  ${row.ms} ms`);
  } catch (e) {
    results.push({ id: t.id, error: e.message });
    console.log(`${t.id.padStart(2)} 💥 ${e.message.slice(0, 120)}`);
  }
}

const ok = results.filter((r) => !r.error);
const n = (f) => ok.filter(f).length;
console.log(`\n${results.length} receipts, ${results.length - ok.length} errors`);
console.log(`total matches label:        ${n((r) => r.totalMatch)}/${ok.length}`);
console.log(`passes our sum check as-is: ${n((r) => r.selfCheck)}/${ok.length}`);
console.log(`both (no edits needed):     ${n((r) => r.totalMatch && r.selfCheck)}/${ok.length}`);
writeFileSync(join(dir, "results.json"), JSON.stringify(results, null, 2));
