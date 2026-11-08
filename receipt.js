// Receipt photo -> line items, using Gemini vision with a fixed JSON schema.
// The model only reads the receipt; split.js checkReceipt() decides whether the numbers add up.
import { GoogleGenAI, createPartFromBase64 } from "@google/genai";
import { z } from "zod";
import { allocate } from "./split.js";

const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";

const Receipt = z.object({
  merchant: z.string(),
  currency: z.string().describe("ISO 4217 code, e.g. EUR"),
  items: z.array(
    z.object({
      name: z.string().describe("Item name as a diner would recognise it, in the receipt's language"),
      quantity: z.number().int().describe("How many units this line covers; 1 if not stated"),
      line_total_cents: z.number().int().describe("Price of the whole line in cents, after any discount on that line"),
    }),
  ),
  subtotal_cents: z.number().int().nullable().describe("Sum of items as printed, before tip/service; null if not printed"),
  total_cents: z.number().int().describe("Final amount paid, including tip or service charge if written on the receipt"),
});

const PROMPT = `Read this restaurant or bar receipt and extract what was ordered.
- One entry per printed line item. Do not list VAT/tax breakdown lines, payment lines, change, or card slips as items.
- Prices in Finland and most of Europe already include VAT; do not add tax on top.
- If there is a tip or service charge, include it in total_cents but not as an item.
- All amounts are integers in cents (12,50 € -> 1250).
- If a value is unreadable, give your best reading; the app will ask the user to check anything that doesn't add up.`;

let ai; // created on first use so the app (and tests) still start without credentials

// Three ways in, first match wins:
// VERTEX_API_KEY: Vertex AI "express mode" key bound to a service account (hosting, e.g. Render);
// GOOGLE_CLOUD_PROJECT: Vertex AI with your gcloud login (local dev); GEMINI_API_KEY: Gemini Developer API.
const { VERTEX_API_KEY, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION = "global", GEMINI_API_KEY } = process.env;
export const geminiConfigured = () => Boolean(VERTEX_API_KEY || GOOGLE_CLOUD_PROJECT || GEMINI_API_KEY);

export async function readReceipt({ mediaType, data }) {
  ai ??= VERTEX_API_KEY
    ? new GoogleGenAI({ vertexai: true, apiKey: VERTEX_API_KEY })
    : GOOGLE_CLOUD_PROJECT
      ? new GoogleGenAI({ vertexai: true, project: GOOGLE_CLOUD_PROJECT, location: GOOGLE_CLOUD_LOCATION })
      : new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [createPartFromBase64(data, mediaType), PROMPT],
    config: { responseMimeType: "application/json", responseJsonSchema: z.toJSONSchema(Receipt) },
  });
  if (!response.text) throw new Error("could not read the receipt (empty model response)");
  // Schema-shaped JSON is still untrusted input: validate before using it.
  const parsed = Receipt.safeParse(JSON.parse(response.text));
  if (!parsed.success) throw new Error(`model returned an unexpected shape: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

// Receipts print discounts and voids as a negative line under the item they apply to:
// fold each into the line above it, and drop lines that end up at zero (fully voided).
function foldNegatives(items) {
  const out = [];
  for (const line of items) {
    const prev = out.at(-1);
    if (line.line_total_cents < 0 && prev && prev.line_total_cents + line.line_total_cents >= 0)
      out[out.length - 1] = { ...prev, line_total_cents: prev.line_total_cents + line.line_total_cents };
    else out.push(line); // a negative we can't place stays, and checkReceipt flags it for the user
  }
  return out.filter((l) => l.line_total_cents !== 0);
}

// One tappable row per unit: "2 × Beer 12.00" becomes two "Beer" rows, so two people can each claim one.
export function toClaimableItems(receipt) {
  return foldNegatives(receipt.items).flatMap((line) => {
    const n = line.quantity > 1 && line.quantity <= 20 ? line.quantity : 1;
    return allocate(line.line_total_cents, Array(n).fill(1)).map((cents) => ({ name: line.name, cents }));
  });
}
