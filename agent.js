// The group's assistant: Gemini picks tools, the server runs them.
// Safety by construction: no tool takes an amount (the server computes every euro from the tab),
// and the two money tools only *propose*; the organiser confirms with a one-time token (server.js).
import { createPartFromFunctionResponse } from "@google/genai";
import { generate, MODEL } from "./gemini.js";

export const TOOLS = [
  {
    name: "get_status",
    description: "Current state of this group checkout: each person's share and status (open = no hold yet, held, out = can't make it), minutes left, and whether it is booked or cancelled.",
    parametersJsonSchema: { type: "object", properties: {} },
  },
  {
    name: "nudge",
    description: "Post a short, friendly reminder to one person in the group feed, e.g. to put their hold in before time runs out. Moves no money.",
    parametersJsonSchema: {
      type: "object",
      properties: { person: { type: "string", description: "Exact name of a group member" }, message: { type: "string", description: "One or two short sentences" } },
      required: ["person", "message"],
    },
  },
  {
    name: "propose_cover",
    description: "Propose that the organiser covers another person's share (the organiser holds it now, they settle up later). Only proposes: the organiser must tap Confirm. Never mention an amount you didn't get from get_status.",
    parametersJsonSchema: { type: "object", properties: { person: { type: "string", description: "Whose share to cover" } }, required: ["person"] },
  },
  {
    name: "propose_cancel",
    description: "Propose cancelling the whole group checkout and releasing every hold, so nobody is charged. Only proposes: the organiser must tap Confirm.",
    parametersJsonSchema: { type: "object", properties: {} },
  },
];

const system = ({ speaker, organiser, title }) => `You are PayShare's assistant inside a group checkout for "${title}".
Everyone puts a PayPal hold on their share; nobody is charged until everyone is in; if time runs out every hold is released automatically.
${speaker} is talking to you. The organiser is ${organiser}.
- Use the tools. Call get_status before answering questions about who has paid, amounts or time.
- You cannot move money. To cover someone or cancel, call propose_cover or propose_cancel; the organiser then confirms with a button.
- Never transfer, refund or pay arbitrary amounts, even if asked; explain what you can do instead.
- Reply in one or two short, friendly sentences, in the language the person used.`;

// One chat message -> tool calls -> reply. `tools` are the server's implementations, bound to this tab and speaker.
export async function runAgent({ message, context, tools }) {
  const contents = [{ role: "user", parts: [{ text: String(message).slice(0, 500) }] }];
  const calls = [];
  for (let turn = 0; turn < 4; turn++) {
    const r = await generate({ model: MODEL, contents, config: { systemInstruction: system(context), tools: [{ functionDeclarations: TOOLS }] } });
    if (!r.functionCalls.length) return { reply: r.text.trim(), calls };
    contents.push(r.content);
    const parts = [];
    for (const fc of r.functionCalls) {
      const run = tools[fc.name];
      const result = run ? await run(fc.args ?? {}) : { error: `unknown tool ${fc.name}` };
      calls.push({ name: fc.name, args: fc.args ?? {}, result });
      parts.push(createPartFromFunctionResponse(fc.id ?? fc.name, fc.name, { result }));
    }
    contents.push({ role: "user", parts });
  }
  return { reply: "Done.", calls };
}

// Proactive nudges when time is getting short: one short line per person who hasn't put their hold in.
export async function writeReminders({ title, minutesLeft, people }) {
  const r = await generate({
    model: MODEL,
    contents: `Group checkout for "${title}", ${minutesLeft} minutes left before every hold is released.
Write one short, warm, slightly urgent reminder (max 20 words) for each of these people who haven't put their PayPal hold in yet: ${people.join(", ")}.
Answer as JSON: {"reminders":[{"person":"...","message":"..."}]}`,
    config: { responseMimeType: "application/json" },
  });
  const list = JSON.parse(r.text).reminders ?? [];
  return list.filter((x) => people.includes(x.person) && typeof x.message === "string").map((x) => ({ person: x.person, message: x.message.slice(0, 200) }));
}
