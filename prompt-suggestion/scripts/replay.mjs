#!/usr/bin/env node
// Replay a real pi session through the suggestion pipeline and print what the model returns.
//
// For each cut point (an assistant reply that ended a turn and was followed by a user message),
// rebuild the request exactly as the extension would, send it, and print: usage / cache hits,
// whether the output parsed, the suggestions, and what the user actually typed next.
//
// Usage:
//   node scripts/replay.mjs <session.jsonl> [options]
//     --model <provider/id>   model from models.json (default: newapi/deepseek-flash)
//     --mode fork|segment     request shape (default: fork)
//     --thinking <level>      session thinking level to mirror in fork mode (default: off)
//     --cuts <n>              number of cut points from the end (default: 3)
//     --last                  also use the final assistant reply (no "actual next" input)
//     --dry                   build requests and print their size without sending
//
// Requires the Node that ships with pi (>= 22.6, type stripping on). Costs real tokens.

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const file = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !["--last", "--dry"].includes(args[i - 1])));
if (!file) {
  console.error("usage: node scripts/replay.mjs <session.jsonl> [--model p/id] [--mode fork|segment] [--thinking lvl] [--cuts n] [--last] [--dry]");
  process.exit(1);
}
const [provider, modelId] = opt("--model", "newapi/deepseek-flash").split("/");
const mode = opt("--mode", "fork");
const thinking = opt("--thinking", "off");
const nCuts = Number(opt("--cuts", "3"));

// Locate pi: PI_ROOT, else the global npm install
const PI_ROOT = process.env.PI_ROOT ?? join(execSync("npm root -g").toString().trim(), "@earendil-works", "pi-coding-agent");
if (!existsSync(PI_ROOT)) throw new Error(`pi not found at ${PI_ROOT}; set PI_ROOT`);
const piPkg = (name) => pathToFileURL(join(PI_ROOT, "node_modules", "@earendil-works", name, "dist", "index.js")).href;
const { SessionManager, buildSessionProjection, convertToLlm, getAgentDir } = await import(pathToFileURL(join(PI_ROOT, "dist", "index.js")).href);
const { complete, completeSimple } = await import(pathToFileURL(join(PI_ROOT, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js")).href);

// Load the extension with its pi imports pointed at the install (plain Node has no jiti aliasing)
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "index.ts"), "utf8")
  .replaceAll('from "@earendil-works/pi-coding-agent"', `from "${pathToFileURL(join(PI_ROOT, "dist", "index.js")).href}"`)
  .replaceAll('from "@earendil-works/pi-tui"', `from "${piPkg("pi-tui")}"`);
const tmp = join(mkdtempSync(join(tmpdir(), "ps-replay-")), "index.ts");
writeFileSync(tmp, src);
const ext = await import(pathToFileURL(tmp).href);

// Model + key from pi's agent dir
const agentDir = getAgentDir();
const prov = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")).providers?.[provider];
const def = prov?.models?.find((m) => m.id === modelId);
if (!def) throw new Error(`model ${provider}/${modelId} not in ${join(agentDir, "models.json")}`);
const model = { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...def, api: prov.api, provider, baseUrl: prov.baseUrl };
const apiKey = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))[provider]?.key;

const sm = SessionManager.open(file);
const entries = sm.getEntries();
const msgs = entries.filter((e) => e.type === "message");
const textOf = (m) => (typeof m.content === "string" ? m.content : m.content.filter((c) => c.type === "text").map((c) => c.text).join(""));
const cuts = msgs.filter((e, i) => {
  const m = e.message;
  if (m.role !== "assistant" || m.stopReason !== "stop" || !textOf(m).trim()) return false;
  return msgs[i + 1] ? msgs[i + 1].message.role === "user" : args.includes("--last");
});

const charLimit = ext.cardCharLimit();
for (const leaf of cuts.slice(-nCuts)) {
  const llm = convertToLlm(buildSessionProjection(entries, leaf.id).messages);
  let context;
  let options;
  if (mode === "segment") {
    const segCtx = { sessionManager: { getBranch: () => sm.getBranch(leaf.id) } };
    context = { systemPrompt: ext.buildInstruction(3, charLimit), messages: [{ role: "user", content: [{ type: "text", text: ext.lastTurnSegment(segCtx) }], timestamp: Date.now() }] };
    options = { cacheRetention: "none" };
  } else {
    ({ context, options } = ext.buildForkRequest(llm, ext.buildForkInstruction(3, charLimit), { thinkingLevel: thinking, sessionId: sm.getSessionId() }));
  }
  const next = msgs[msgs.indexOf(leaf) + 1]?.message;
  const base = { leaf: leaf.id.slice(-6), mode, msgs: context.messages.length, actualNext: next ? textOf(next).slice(0, 60) : "(none)" };
  if (args.includes("--dry")) {
    console.log(JSON.stringify({ ...base, chars: JSON.stringify(context).length }));
    continue;
  }
  const t0 = Date.now();
  const res = await (options.reasoning ? completeSimple : complete)(model, context, { ...options, apiKey });
  const text = res.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  const u = res.usage ?? {};
  const total = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  const parsed = ext.parseOutput(text, 3, charLimit);
  console.log(JSON.stringify({
    ...base, ms: Date.now() - t0, stop: res.stopReason, total, cacheRead: u.cacheRead, cacheHit: total ? +(100 * (u.cacheRead ?? 0) / total).toFixed(1) : 0,
    out: u.output, parsed: parsed.parsed, suggestions: parsed.cards, ...(parsed.parsed ? {} : { raw: text.slice(0, 160) }), error: res.errorMessage?.slice(0, 160),
  }));
}
