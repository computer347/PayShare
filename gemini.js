// One Gemini client for the receipt reader and the agent.
// Three ways in, first match wins:
// VERTEX_API_KEY: Vertex AI "express mode" key bound to a service account (hosting, e.g. Render);
// GOOGLE_CLOUD_PROJECT: Vertex AI with your gcloud login (local dev); GEMINI_API_KEY: Gemini Developer API.
import { GoogleGenAI } from "@google/genai";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";
const { VERTEX_API_KEY, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION = "global", GEMINI_API_KEY, GEMINI_CACHE } = process.env;
export const geminiConfigured = () => Boolean(VERTEX_API_KEY || GOOGLE_CLOUD_PROJECT || GEMINI_API_KEY);

let ai; // created on first use so the app (and tests) still start without credentials
export const gemini = () =>
  (ai ??= VERTEX_API_KEY
    ? new GoogleGenAI({ vertexai: true, apiKey: VERTEX_API_KEY })
    : GOOGLE_CLOUD_PROJECT
      ? new GoogleGenAI({ vertexai: true, project: GOOGLE_CLOUD_PROJECT, location: GOOGLE_CLOUD_LOCATION })
      : new GoogleGenAI({ apiKey: GEMINI_API_KEY }));

// Optional replay cache (GEMINI_CACHE=path.json): identical requests get the recorded answer, so the eval
// and the video's demo path don't depend on rate limits. Off by default.
let cache;
const load = () => { try { return JSON.parse(readFileSync(GEMINI_CACHE, "utf8")); } catch { return {}; } };
export async function generate(request) {
  const key = GEMINI_CACHE && createHash("sha256").update(JSON.stringify(request)).digest("hex");
  if (key) { cache ??= load(); if (cache[key]) return cache[key]; }
  const r = await gemini().models.generateContent(request);
  const content = r.candidates?.[0]?.content;
  // Join the answer's text parts ourselves (r.text warns when the answer also holds tool calls); skip thoughts.
  const text = (content?.parts ?? []).filter((p) => p.text && !p.thought).map((p) => p.text).join("");
  const out = { text, functionCalls: r.functionCalls ?? [], content };
  if (key) { cache[key] = out; writeFileSync(GEMINI_CACHE, JSON.stringify(cache)); }
  return out;
}
