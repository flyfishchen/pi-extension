#!/usr/bin/env node
// Replay a real pi session through the suggestion pipeline and print what the model returns.
//
// For each cut point (an assistant reply that ended a turn and was followed by a user message),
// build the request with the extension's own builders, send it the way the extension does
// (fork: streamSimple with the thinking level; segment: complete), and print: usage / cache hits,
// whether the output parsed, the suggestions, and what the user actually typed next.
//
// Usage:
//   node scripts/replay.mjs <session.jsonl> --model <provider/id> [options]
//     --model <provider/id>   model from models.json (required)
//     --mode fork|segment     request shape (default: fork)
//     --thinking <level>      session thinking level to mirror in fork mode (default: off)
//     --cuts <n>              number of cut points from the end (default: 3)
//     --last                  also use the final assistant reply (no "actual next" input)
//     --dry                   build requests and print their size without sending
//     --raw                   always print the raw model output (also when it parsed)
//     --manual                use the Tab-triggered (manual) instruction
//
// Requires the Node that ships with pi (>= 22.6, type stripping on). Costs real tokens.

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const USAGE = "usage: node scripts/replay.mjs <session.jsonl> --model provider/id [--mode fork|segment] [--thinking level] [--cuts n] [--last] [--dry] [--raw] [--manual]";
const VALUE_FLAGS = new Set(["--model", "--mode", "--thinking", "--cuts"]);
const BOOL_FLAGS = new Set(["--last", "--dry", "--raw", "--manual"]);

function fail(msg) {
  console.error(`${msg}\n${USAGE}`);
  process.exit(1);
}

// Parse arguments strictly: unknown flags or a value flag without a value are errors
const opts = {};
const positional = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUE_FLAGS.has(a)) {
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) fail(`${a} needs a value`);
    opts[a] = v;
  } else if (BOOL_FLAGS.has(a)) opts[a] = true;
  else if (a.startsWith("--")) fail(`unknown option ${a}`);
  else positional.push(a);
}
if (positional.length !== 1) fail("expected exactly one session file");
const file = positional[0];

const modelSpec = opts["--model"];
if (modelSpec === undefined) fail("--model is required");
const slash = modelSpec.indexOf("/");
if (slash <= 0) fail(`--model must be provider/id, got "${modelSpec}"`);
const provider = modelSpec.slice(0, slash);
const modelId = modelSpec.slice(slash + 1); // ids may themselves contain "/"
const mode = opts["--mode"] ?? "fork";
if (mode !== "fork" && mode !== "segment") fail(`--mode must be fork or segment, got "${mode}"`);
const thinking = opts["--thinking"] ?? "off";
const manual = opts["--manual"] === true;
const nCuts = Number(opts["--cuts"] ?? "3");
if (!Number.isInteger(nCuts) || nCuts < 1) fail(`--cuts must be a positive integer, got "${opts["--cuts"]}"`);

// Locate pi: PI_ROOT, else the global npm install
const PI_ROOT = process.env.PI_ROOT ?? join(execSync("npm root -g").toString().trim(), "@earendil-works", "pi-coding-agent");
if (!existsSync(PI_ROOT)) throw new Error(`pi not found at ${PI_ROOT}; set PI_ROOT`);
const fileUrl = (...parts) => pathToFileURL(join(...parts)).href;
const { SessionManager, buildSessionProjection, convertToLlm, getAgentDir } = await import(fileUrl(PI_ROOT, "dist", "index.js"));
const { complete, completeSimple } = await import(fileUrl(PI_ROOT, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js"));

// Load the extension with its pi imports pointed at the install (plain Node has no jiti aliasing)
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "index.ts"), "utf8")
  .replaceAll('from "@earendil-works/pi-coding-agent"', `from "${fileUrl(PI_ROOT, "dist", "index.js")}"`)
  .replaceAll('from "@earendil-works/pi-tui"', `from "${fileUrl(PI_ROOT, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js")}"`);
const tmpDir = mkdtempSync(join(tmpdir(), "ps-replay-"));
let ext;
try {
  const tmp = join(tmpDir, "index.ts");
  writeFileSync(tmp, src);
  ext = await import(pathToFileURL(tmp).href);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

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
  return msgs[i + 1] ? msgs[i + 1].message.role === "user" : opts["--last"] === true;
});

const charLimit = ext.cardCharLimit();
for (const leaf of cuts.slice(-nCuts)) {
  let req;
  if (mode === "segment") {
    const segment = ext.lastTurnSegment({ sessionManager: { getBranch: () => sm.getBranch(leaf.id) } });
    req = ext.buildSegmentRequest(segment, charLimit, manual);
  } else {
    const llm = convertToLlm(buildSessionProjection(entries, leaf.id).messages);
    // The live extension passes ctx.getSystemPrompt(), used only when the projection has no leading
    // system message (older sessions). It isn't recoverable offline, so flag those cuts.
    if (llm[0]?.role !== "system") console.error(`warning: ${leaf.id.slice(-6)} has no system message in the session; replayed without one`);
    req = ext.buildForkRequest(llm, ext.buildForkInstruction(ext.CANDIDATES, charLimit, manual), { thinkingLevel: thinking, sessionId: sm.getSessionId() });
  }
  const next = msgs[msgs.indexOf(leaf) + 1]?.message;
  const base = { leaf: leaf.id.slice(-6), mode, msgs: req.context.messages.length, actualNext: next ? textOf(next).slice(0, 60) : "(none)" };
  if (opts["--dry"]) {
    console.log(JSON.stringify({ ...base, chars: JSON.stringify(req.context).length }));
    continue;
  }
  const t0 = Date.now();
  // Same call path as the extension: fork goes through streamSimple, segment through complete
  const send = mode === "fork" ? completeSimple : complete;
  const res = await send(model, req.context, { ...req.options, apiKey });
  const text = res.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  const u = res.usage ?? {};
  const total = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  const parsed = ext.parseOutput(text, ext.CANDIDATES, charLimit);
  console.log(JSON.stringify({
    ...base, ms: Date.now() - t0, stop: res.stopReason, total, cacheRead: u.cacheRead, cacheHit: total ? +(100 * (u.cacheRead ?? 0) / total).toFixed(1) : 0,
    out: u.output, parsed: parsed.parsed, suggestions: parsed.cards, ...(parsed.parsed && !opts["--raw"] ? {} : { raw: text.slice(0, 400) }), error: res.errorMessage?.slice(0, 160),
  }));
}
