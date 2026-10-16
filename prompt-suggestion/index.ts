import { convertToLlm, CustomEditor, DynamicBorder, getAgentDir, getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UserMessage } from "@earendil-works/pi-ai";
import { Container, Key, matchesKey, SelectList, SettingsList, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SettingItem } from "@earendil-works/pi-tui";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * prompt-suggestion: predict what the user is most likely to type next and show it as dimmed ghost
 * text in the empty input box (one suggestion). Tab in an empty input box with no suggestion showing
 * generates one; with an idle delay configured, one is also generated automatically once a turn ends
 * and the input box has been idle that long. Tab accepts it, Esc dismisses it; typing (or accepting)
 * hides it and clearing the input box brings it back. Sending a message or a new turn discards it.
 *
 * Prompt and validation follow Claude Code 2.1.x's prompt-suggestion subsystem:
 * - predict what the user would type themselves, not what the assistant would suggest;
 * - the prompt gives a test, situational examples, prohibitions (evaluation / assistant voice /
 *   new ideas / multiple sentences) and a "stay silent" clause;
 * - model output then goes through a deterministic filter (length, word count, multiple sentences,
 *   evaluative phrases, assistant voice, meta text, wrappers, Markdown, code, ...);
 * - "segment" sends a short excerpt; "fork" replays the full session to reuse its prompt cache.
 */

const WIDGET_KEY = "prompt-suggestion";
const UNSET_MODEL_LABEL = "Not set";
// pi's agent dir (~/.pi/agent on Linux/macOS, %USERPROFILE%\.pi\agent on Windows; PI_CODING_AGENT_DIR overrides)
const CONFIG_PATH = join(getAgentDir(), "prompt-suggestion.json");
const DEFAULT_LOG_PATH = join(getAgentDir(), "prompt-suggestion.log");

/**
 * Number of candidates requested from the model (fixed, not configurable). Only the first
 * candidate that passes the filter is shown; the extras are backups for when the first one is
 * rejected (too long, Markdown, assistant voice, ...).
 */
const CANDIDATES = 3;
/** Default maximum characters per suggestion */
const DEFAULT_MAX_CARD_CHARS = 50;
/** Baseline word limit for non-CJK suggestions (CJK is bounded by the character limit instead) */
const MAX_CARD_WORDS = 12;
/** Upper bound of the configurable character limit */
const MAX_CARD_CHARS_CAP = 100;

/** Word limit for non-CJK text: at least 12, scaled up with the character limit (~6 chars/word) */
function cardWordLimit(charLimit: number): number {
  return Math.max(MAX_CARD_WORDS, Math.round(charLimit / 6));
}
/** Default idle delay: 0 = no automatic suggestions (Tab generates one) */
const DEFAULT_DELAY_SECONDS = 0;
/** Only suggest after at least two assistant replies (Claude Code's early_conversation suppression) */
const MIN_ASSISTANT_TURNS = 2;
/** Cold-cache threshold: skip fork if last turn's uncached tokens exceed this (Claude Code uses 1e4) */
const CACHE_COLD_TOKENS = 10_000;
/** Cache freshness: treat the cache as expired if the last reply is older than this (0 = no check) */
const DEFAULT_CACHE_TTL_SECONDS = 300;
/** Forks smaller than this don't count as cache misses for the cold-streak breaker */
const FORK_MIN_TOKENS = 2000;
/**
 * Fork context token cap. Default 0 = unlimited: with a cache hit even a large context is only a
 * cheap cache read (measured 99.9% hits on 197k); cost risk is handled by the cold-cache gate
 * (CACHE_COLD_TOKENS), not by size. Set only if a hard cap is wanted.
 */
const DEFAULT_MAX_FORK_TOKENS = 0;

interface SuggestionConfig {
  /** Tab in an empty input box generates a suggestion immediately (default true) */
  tabToGenerate?: boolean;
  /**
   * Model for segment requests (segment mode and fork's fallback), "provider/model-id".
   * Unset (or not found) = no segment requests: segment mode generates nothing and fork has no
   * fallback. Fork always uses the session model: only that model shares the session's prompt cache.
   */
  segmentModel?: string;
  /** Maximum characters per suggestion (8-100, default 50) */
  maxCardChars?: number;
  /** Idle seconds before an automatic suggestion (5-600; default 0 = no automatic suggestions, Tab only) */
  delaySeconds?: number;
  /**
   * Context mode:
   * - "fork" (default): replay the real system prompt + full model context. Like Claude Code's cacheSafeParams,
   *   the request is identical to the session's except for the appended instruction (same thinking
   *   level, same tools, no tool_choice/response_format), so it hits the session's prompt cache.
   *   Falls back to segment if the model doesn't comply (no JSON / tries to call a tool), and is
   *   paused while the cache is cold or expired (resumes once a later turn warms it) and turned off
   *   for the session after two consecutive forks miss the cache.
   * - "segment": a short excerpt of the conversation + this extension's own system prompt, sent to
   *   the segment model. Cheap and reliably returns JSON.
   */
  context?: "segment" | "fork";
  /** Fork context token cap (0 = unlimited, default 0) */
  maxForkTokens?: number;
  /** Cache freshness in seconds (0 = no check, default 300) */
  cacheTtlSeconds?: number;
  /**
   * Diagnostic log: when true, append one JSONL line per generation (fork or segment, skip reason,
   * usage, whether it parsed) to prompt-suggestion.log in pi's agent dir. PI_SUGGESTION_LOG=<path> also enables it.
   */
  debugLog?: boolean;
}

/** Append one diagnostic log line (no-op when disabled; write errors are ignored). */
function logEvent(ev: Record<string, unknown>) {
  const path = process.env.PI_SUGGESTION_LOG || (loadConfig().debugLog ? DEFAULT_LOG_PATH : undefined);
  if (!path) return;
  try {
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...ev }) + "\n", "utf8");
  } catch {
    // logging must never affect suggestions
  }
}

/** Compact usage, for comparing with the session's billing */
function usageBrief(u: any) {
  if (!u) return undefined;
  return { input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, output: u.output, total: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) };
}

/** Parsed config, keyed by the file's mtime and size so edits apply without /reload */
let configCache: { key: string; cfg: SuggestionConfig } | undefined;

function loadConfig(): SuggestionConfig {
  let key: string;
  try {
    const st = statSync(CONFIG_PATH);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    return {}; // no config file
  }
  if (configCache?.key === key) return configCache.cfg;
  let cfg: SuggestionConfig = {};
  try {
    // Strip a UTF-8 BOM (Windows editors such as Notepad may add one; JSON.parse rejects it)
    cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    cfg = {};
  }
  configCache = { key, cfg };
  return cfg;
}

function saveConfig(cfg: SuggestionConfig) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  configCache = undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function cardCharLimit(): number {
  const n = loadConfig().maxCardChars ?? DEFAULT_MAX_CARD_CHARS;
  return Number.isFinite(n) ? clamp(Math.round(n), 8, MAX_CARD_CHARS_CAP) : DEFAULT_MAX_CARD_CHARS;
}

/** Idle delay before an automatic suggestion; undefined when turned off (delaySeconds: 0) */
function delayMs(): number | undefined {
  const n = loadConfig().delaySeconds ?? DEFAULT_DELAY_SECONDS;
  if (n === 0) return undefined;
  return (Number.isFinite(n) ? clamp(n, 5, 600) : DEFAULT_DELAY_SECONDS) * 1000;
}

/** Resolve the segment model; undefined when unset or not found (segment requests are then not sent). */
function resolveSegmentModel(ctx: ExtensionContext) {
  const spec = loadConfig().segmentModel;
  const slash = spec?.indexOf("/") ?? -1;
  if (!spec || slash <= 0) return undefined;
  return ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1)) ?? undefined;
}

/** Context mode is fork unless segment is chosen explicitly */
function isForkMode(): boolean {
  return loadConfig().context !== "segment";
}

/** Whether anything can be generated: fork mode, or segment mode with a segment model configured */
function canGenerate(ctx: ExtensionContext): boolean {
  return isForkMode() || !!resolveSegmentModel(ctx);
}

/**
 * Segment-mode system prompt, modeled on Claude Code's prompt-suggestion prompt.
 */
/**
 * Extra rule when the user pressed Tab to ask for a suggestion: an unclear next step is no reason to
 * stay silent (the user asked), but failures and credentials/privacy still are.
 */
const MANUAL_NOTE =
  "The user pressed Tab to ask for a suggestion, so give your best guess even when the next step is unclear: if the last reply asked the user something, predict the user's most likely answer; if it listed options, pick the likeliest one. Stay silent only if something failed or it involves security, credentials or privacy.";

function buildInstruction(maxCards: number, maxChars: number, manual = false): string {
  return `[Prompt suggestion mode]
You are not a coding assistant right now. Do not execute, continue, restate, summarize or evaluate the conversation.
Your only task: predict what the user is most likely to type themselves after reading the last assistant reply.
The test: would the user read it and think "that's exactly what I was about to say"?
Situations:
- A bug was just fixed or code was just written -> the user usually asks to verify it (say what and how)
- The assistant offered several options -> the option the user would most likely pick (name it)
- The assistant asked whether to continue -> continue
${manual ? "- Something failed -> stay silent\n" + MANUAL_NOTE : "- Something failed or the assistant misunderstood -> stay silent"}
Be specific: naming what to run or check beats a generic "continue".
Never output:
- Markdown (headings, quotes, tables) or code/config snippets
- Evaluations ("looks good", "thanks")
- The assistant's voice ("let me...", "I'll...", "here is...")
- New ideas the user never mentioned, or more than one sentence
${manual ? "If it involves security, credentials or privacy, output []." : "If the next step isn't obvious, or it involves security, credentials or privacy, output []."}
Language: write every item in the language of the user's own recent messages, in their style and wording. If the user writes Chinese, write Chinese, even when the assistant replied in English or these instructions are in English.
Output must be a JSON array of strings: at most ${maxCards} items, most likely first, all different; output [] if nothing fits.
Each item at most ${maxChars} characters (for English, 2-${cardWordLimit(maxChars)} words).
Output only the JSON, no explanation; start with [ and end with ].`;
}

let inflight: AbortController | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

function cancelTimer() {
  if (timer) clearTimeout(timer);
  timer = undefined;
}

/** Cancel a pending timer and in-flight request, and clear the ghost text. */
function cancelSuggestion() {
  cancelTimer();
  inflight?.abort();
  inflight = undefined;
  clearGhost();
}

function textOf(msg: any): string {
  if (typeof msg.content === "string") return msg.content.trim();
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n")
    .trim();
}

/** Truncate when too long; fromEnd=true keeps the tail (for the assistant's final output). */
function clip(s: string, max: number, fromEnd = false): string {
  if (s.length <= max) return s;
  return fromEnd ? "...(earlier text truncated)\n" + s.slice(-max) : s.slice(0, max) + "\n...(rest truncated)";
}

/**
 * Excerpt for segment mode: the last few user messages + previous assistant output + this turn's
 * assistant output. Several user messages are kept so the model sees the original request, not
 * just the last line. Tool results are recorded by tool name only.
 */
function lastTurnSegment(ctx: ExtensionContext): string {
  const msgs: any[] = [];
  for (const e of ctx.sessionManager.getBranch()) {
    if (e.type === "message") msgs.push(e.message);
  }

  let u = msgs.length - 1;
  while (u >= 0 && msgs[u].role !== "user") u--;
  if (u < 0) return "";

  // Recent user messages (including this turn's), oldest first, at most 3
  const recentUsers: string[] = [];
  for (let i = u; i >= 0 && recentUsers.length < 3; i--) {
    if (msgs[i].role !== "user") continue;
    const t = textOf(msgs[i]);
    if (t) recentUsers.unshift(clip(t, 800));
  }

  // This turn's assistant output (after the user message). Consecutive tool runs are collapsed into
  // one line ("[tools ran: bash ×30, read]") so they don't crowd out the reply text.
  const current: string[] = [];
  let tools = new Map<string, number>();
  const flushTools = () => {
    if (tools.size === 0) return;
    current.push(`[tools ran: ${[...tools].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(", ")}]`);
    tools = new Map();
  };
  for (let i = u + 1; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "assistant") {
      const t = textOf(m);
      if (t) {
        flushTools();
        current.push(t);
      }
    } else if (m.role === "toolResult") {
      tools.set(m.toolName, (tools.get(m.toolName) ?? 0) + 1);
    }
  }
  flushTools();

  // Previous assistant output (latest assistant message with text before the user message)
  let prevAssistant = "";
  for (let i = u - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") {
      const t = textOf(msgs[i]);
      if (t) {
        prevAssistant = t;
        break;
      }
    }
  }

  const parts: string[] = [];
  if (recentUsers.length > 0) parts.push(`Recent user messages (oldest first):\n${recentUsers.join("\n---\n")}`);
  if (prevAssistant) parts.push(`Previous assistant output:\n${clip(prevAssistant, 1200)}`);
  parts.push(`Latest assistant output:\n${clip(current.join("\n\n"), 2200, true)}`);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Output validation (mirrors Claude Code's deterministic filter, incl. CJK handling)
// ---------------------------------------------------------------------------

const HAN = /\p{Script=Han}/u;
const PHONETIC = /[\p{Script=Hiragana}\p{Script=Katakana}ーｰ\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const HANGUL = /\p{Script=Hangul}/u;
const LETTER = /[\p{L}\p{N}]/u;

function cjkCount(s: string): number {
  let n = 0;
  for (const ch of s) if (HAN.test(ch) || PHONETIC.test(ch) || HANGUL.test(ch)) n++;
  return n;
}

/** Word count: whitespace-separated words; CJK counted by characters (1 Han ≈ 0.5 word), as in Claude Code. */
function wordCount(text: string): number {
  const t = text.trim();
  if (t === "") return 0;
  let total = 0;
  for (const tok of t.split(/\s+/)) {
    let han = 0;
    let phon = 0;
    let hangul = 0;
    let other = 0;
    for (const ch of tok) {
      if (HAN.test(ch)) han++;
      else if (PHONETIC.test(ch)) phon++;
      else if (HANGUL.test(ch)) hangul++;
      else if (LETTER.test(ch)) other++;
    }
    total += han === 0 && phon === 0 ? 1 : (other + hangul > 0 ? 1 : 0) + han / 2 + phon / 4;
  }
  return Math.ceil(total);
}

/** Single-word replies that are valid input on their own */
const SHORT_OK = new Set([
  "yes", "yeah", "yep", "yea", "yup", "sure", "ok", "okay",
  "push", "commit", "deploy", "stop", "continue", "check", "exit", "quit", "no",
]);

// The CJK alternatives below are intentional: they recognize Chinese/Japanese/Korean output.
const DONE = /^\P{L}*(done|完了(しました)?|完成了?|搞定了?|好了|다\s*됐어|완료)\P{L}*$/iu;
const META_TEXT = /^(nothing found\.?|no suggestion|nothing to suggest|silence)$/i;
const META_TEXT_CJK = /(沉默|静默|没有必要|没有建议|无需|特になし|なし|없음)/i;
const META_WRAPPED = /^(\(.*\)|\[.*\]|（.*）|【.*】|「.*」)$/u;
const ERROR_LIKE = /^(api error:|prompt is too long|request timed out|invalid api key|image was too large)/i;
const PREFIXED_LABEL = /^[\p{L}\p{N}_]{1,16}\s*[：:]\s+/u;
const MULTI_SENTENCE = /[.!?]\s+[A-Z]|[。！？]\s*[\p{L}\p{N}]/u;
const HAS_FORMATTING = /[\n*]|\*\*/;
/** Markdown structure (headings / quotes / tables) is never user input */
const MARKDOWN_LIKE = /^\s*(#{1,6}\s|>\s|\|.*\|)/;
/**
 * Code / config snippets are never user input. Keywords alone are not enough: "import the csv again"
 * or "for option 2 go ahead" are normal requests, so each keyword must come with code syntax.
 */
const CODE_LIKE =
  /[{}`]|=>|^\s*(?:const|let|var)\s+[\w$]+\s*=|^\s*import\s+(?:[\w${},*\s]+\s+from\s+)?["']|^\s*export\s+(?:default|const|function|class)\b|^\s*(?:def|function|class)\s+[\w$]+\s*[(:{]|^\s*(?:return|await)\s+[\w$.]+\(|^\s*(?:if|for|while)\s*\(/;
const EVALUATIVE = /\b(thanks|thank you|looks good|sounds good|that works|that worked|that's all|nice|great|perfect|makes sense|awesome|excellent)\b/i;
const EVALUATIVE_CJK = /^(谢谢|多谢|感谢|好的|好嘞|看起来不错|太好了|完美|辛苦了|ありがとう|助かりました|감사합니다|고마워요)/u;
const CLAUDE_VOICE = /^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly)/i;
const CLAUDE_VOICE_CJK = /^(让我|我来|我会|我将|这里|这是|以下是|可以帮你|帮你|建议你|让我来)/u;

/** Whether a candidate looks like something the user would type. Returns null if it passes, else the reason. */
function rejectReason(raw: string, charLimit = DEFAULT_MAX_CARD_CHARS): string | null {
  const s = raw.trim();
  if (!s) return "empty";
  const lower = s.toLowerCase();
  if (DONE.test(s)) return "done";
  if (META_TEXT.test(s) || META_TEXT_CJK.test(s)) return "meta_text";
  if (META_WRAPPED.test(s)) return "meta_wrapped";
  if (ERROR_LIKE.test(s)) return "error_message";
  if (s.split("\n").length > 1 || HAS_FORMATTING.test(s)) return "has_formatting";
  if (MARKDOWN_LIKE.test(s)) return "markdown_like";
  if (CODE_LIKE.test(s)) return "code_like";
  if (s.length > charLimit) return "too_long";
  if (MULTI_SENTENCE.test(s)) return "multiple_sentences";
  if (PREFIXED_LABEL.test(s)) return "prefixed_label";
  if (EVALUATIVE.test(s) || EVALUATIVE_CJK.test(s)) return "evaluative";
  if (CLAUDE_VOICE.test(s) || CLAUDE_VOICE_CJK.test(s)) return "claude_voice";
  const words = wordCount(s);
  // Word limit applies to non-CJK text; CJK is bounded by the character limit (else 30 Han = 15 words would fail)
  if (cjkCount(s) === 0 && words > cardWordLimit(charLimit)) return "too_many_words";
  if (words < 2) {
    if (s.startsWith("/")) return null; // slash command
    const cjk = cjkCount(s);
    if (cjk > 0) return cjk < 2 ? "too_few_words" : null;
    return SHORT_OK.has(lower) ? null : "too_few_words";
  }
  return null;
}

/** Strip `<suggestion>…</suggestion>` wrappers and "Suggestion:" style prefixes. */
function stripWrappers(s: string): string {
  return s
    .replace(/^<(suggestion|response|output|answer|result)>([\s\S]*)<\/\1>$/i, (_m, _tag, inner: string) => inner)
    .replace(
      /^\s*(suggested\s+(response|reply|input|prompt)|suggestion|response|reply|answer|output|result|建议|回答|答案|输出|结果)\s*[：:]\s*/i,
      "",
    )
    .trim();
}

/** Strip list markers, numbering, surrounding quotes and trailing punctuation. */
function stripListMarkers(s: string): string {
  return s
    .replace(/^\s*(?:[-*•·]|\d+[.)、])\s*/, "")
    .replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, "")
    .replace(/[。．.!！~～]+$/, "")
    .trim();
}

function dedupeKey(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}]/gu, "");
}

/**
 * Parse model output. `parsed` says whether the model actually returned JSON (even an empty list).
 * Deliberately no line-splitting fallback: if the model writes Markdown or code, headings and code
 * lines would become suggestions. Better parsed=false (the caller decides) than garbage.
 */
function parseOutput(text: string, limit: number, charLimit = DEFAULT_MAX_CARD_CHARS): { cards: string[]; parsed: boolean } {
  const raw = text.replace(/```[a-z]*\n?/gi, "").trim();
  let items: string[] | undefined;

  // Fork output: {"suggestions": [...]} (must be an object; take its first string array)
  if (raw.startsWith("{")) {
    try {
      const obj: any = JSON.parse(raw);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const arr = Array.isArray(obj.suggestions) ? obj.suggestions : Object.values(obj).find(Array.isArray);
        if (Array.isArray(arr)) items = arr.filter((x: unknown): x is string => typeof x === "string");
      }
    } catch {
      // fall through to array parsing
    }
  }

  const arrMatch = items === undefined ? raw.match(/\[[\s\S]*\]/) : null;
  if (arrMatch) {
    try {
      const arr: unknown = JSON.parse(arrMatch[0]);
      if (Array.isArray(arr)) items = arr.filter((x): x is string => typeof x === "string");
    } catch {
      // Invalid JSON: only split when the whole output really is a bracketed list
      if (/^\[[\s\S]*\]$/.test(raw)) items = raw.slice(1, -1).split(/\n|,|;|；/);
    }
  }
  if (items === undefined) return { cards: [], parsed: false };

  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const cleaned = stripListMarkers(stripWrappers(String(it)));
    if (rejectReason(cleaned, charLimit)) continue;
    const key = dedupeKey(cleaned);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= limit) break;
  }
  return { cards: out, parsed: true };
}

function userInstructionMessage(text: string): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

/**
 * Completed assistant turns: replies that ended the turn (stopReason "stop") with text. Intermediate
 * messages such as "Let me look at the file" + a tool call end with "toolUse" and don't count.
 */
function assistantTurns(ctx: ExtensionContext): number {
  let n = 0;
  for (const e of ctx.sessionManager.getBranch()) {
    const m = (e as any).message;
    if (e.type === "message" && m?.role === "assistant" && m.stopReason === "stop" && textOf(m)) n++;
  }
  return n;
}

/** Latest assistant message entry (with usage and timestamp), for the cold-cache check. */
function lastAssistantEntry(ctx: ExtensionContext): any | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const e: any = branch[i];
    if (e.type === "message" && e.message?.role === "assistant") return e;
  }
  return undefined;
}

/**
 * Whether the cache is likely warm:
 * 1) freshness: the last assistant message is older than cacheTtlSeconds -> probably expired;
 * 2) usage (Claude Code's O()): last turn's uncached tokens (input+output) above the threshold -> cold.
 * pi's Usage.input excludes cacheRead/cacheWrite, matching Anthropic semantics.
 * Without usage info treat as warm, so providers that don't report caching still get suggestions.
 */
function cacheState(ctx: ExtensionContext): "warm" | "expired" | "cold" {
  const e = lastAssistantEntry(ctx);
  const u = e?.message?.usage;
  if (!u) return "warm";
  const ttlSeconds = loadConfig().cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
  if (ttlSeconds > 0) {
    const ts = Date.parse(e.timestamp ?? "");
    if (Number.isFinite(ts) && Date.now() - ts > ttlSeconds * 1000) return "expired";
  }
  // cacheWrite is deliberately not counted: tokens just written to the cache are exactly what the
  // fork reads back, so a turn with a large (cached) tool result is the cheapest time to fork
  const fresh = (u.input ?? 0) + (u.output ?? 0);
  return fresh <= CACHE_COLD_TOKENS ? "warm" : "cold";
}

function cacheIsWarm(ctx: ExtensionContext): boolean {
  return cacheState(ctx) === "warm";
}

/** Consecutive "large request with zero cache hits" count; fork is disabled at 2 (one warm-up allowed) */
let coldForkStreak = 0;
/**
 * Set when fork is turned off for the rest of this session (repeated misses: the fork's prefix never
 * matches the cache); null while fork is allowed. Cleared on session start (new, resume, fork, /reload).
 * A cold or expired cache is not latched: it is re-checked on every generation, so fork resumes as
 * soon as a later turn warms the cache again.
 */
let forkOffReason: string | null = null;

/** For tests and session lifecycle: reset the adaptive fork state */
function resetForkState() {
  coldForkStreak = 0;
  forkOffReason = null;
}

/**
 * Adapt to the fork's real usage. A large request with zero cache hits may be a normal first warm-up
 * or a prefix that never matches. Allow one; two in a row disables fork for this session.
 * Any hit resets the count.
 */
function recordForkOutcome(usage: any) {
  if (!usage) return;
  const cached = usage.cacheRead ?? 0;
  const prompt = (usage.input ?? 0) + cached + (usage.cacheWrite ?? 0);
  if (prompt >= FORK_MIN_TOKENS && cached === 0) coldForkStreak += 1;
  else coldForkStreak = 0;
  if (coldForkStreak >= 2) forkOffReason = "cold_streak";
}

/** Why fork can't be used now; null when it can. Cold/expired only pause fork until a turn warms the cache. */
function forkSkipReason(ctx: ExtensionContext): string | null {
  if (forkOffReason) return forkOffReason;
  const cfg = loadConfig();
  // fork by default; segment only when context:"segment" is set explicitly
  if (cfg.context === "segment") return "context_not_fork";
  if (typeof (ctx.sessionManager as any)?.buildSessionProjection !== "function") return "no_projection_api";
  const maxTok = cfg.maxForkTokens ?? DEFAULT_MAX_FORK_TOKENS;
  const usage = ctx.getContextUsage?.();
  if (maxTok > 0 && usage?.tokens != null && usage.tokens > maxTok) return "over_max_fork_tokens";
  const state = cacheState(ctx);
  return state === "warm" ? null : state === "expired" ? "cache_expired" : "cache_cold";
}

/**
 * Fork-mode instruction (the user message appended after the real context).
 *
 * Differences from the segment prompt (to stop the model ignoring it under a real coding-agent
 * system prompt + tools):
 * - it first states that the message comes from the input box's autocomplete, not a task or pasted
 *   text; otherwise the model analyzes the instruction as if the user pasted it;
 * - no "[system instruction] / override your role" wording, which reads like an injection;
 * - output is a JSON object {"suggestions": [...]};
 * - the output contract comes last, where attention is strongest;
 * - situations only describe what to write, without concrete phrases: concrete phrases
 *   ("commit it", "use option 2") get copied verbatim even when nothing in the conversation fits.
 */
function buildForkInstruction(maxCards: number, maxChars: number, manual = false): string {
  return `<autocomplete_request>
This message is not a task from the user, and not pasted content for you to analyze, explain or answer. It comes from the input box's prediction feature; the user cannot see it.
Do not continue the work above, do not call tools, do not restate, summarize or evaluate the conversation.

Do exactly one thing: based on the whole conversation above, predict the next message the user is most likely to type into the input box after reading your last reply.
The test: the user would read it and think "yes, that's exactly what I was about to say".
Base the prediction only on the end of your last reply and on how the user usually talks in this session:
- You just changed or wrote something -> the user usually asks to verify it (say what to verify and how)
- You offered several options -> the one the user would most likely pick (name it)
- You asked whether to continue -> continue
- Your reply has a specific point the user would likely ask about -> a follow-up question on that point
${manual ? "- Something failed or it involves credentials/privacy -> no prediction\n" + MANUAL_NOTE : "- Something failed, you misunderstood, the next step is unclear, or it involves credentials/privacy -> no prediction"}
Do not write generic lines with no basis in the conversation (such as an out-of-nowhere "commit" or "run the tests"), and do not return to earlier topics that are already finished.
Requirements: the user's voice (not the assistant's), one sentence, specific; no Markdown, code, evaluation or pleasantries; when unsure give fewer, don't pad.

Output format (strict): output only one JSON object, like {"suggestions": ["first prediction", "second prediction"]}.
Language: write each suggestion in the language of the user's own messages in this session (if the user writes Chinese, write Chinese, even though these instructions are in English).
At most ${maxCards} suggestions, most likely first, all different, each at most ${maxChars} characters; if nothing fits, output {"suggestions": []}.
</autocomplete_request>
Now output only that JSON object; the first character must be {`;
}

/** Extension API (to read the session's current thinking level) */
let piApi: ExtensionAPI | undefined;

/**
 * Pure function: build the fork request from converted model messages (testable offline).
 *
 * Like Claude Code's cacheSafeParams: apart from the appended user instruction, the request must be
 * identical to the session's own, so it hits the session's prompt cache instead of starting a separate
 * cache line (effectively a second, independent session). Measured on DeepSeek:
 * - a thinking level different from the session -> past reasoning_content isn't rendered
 *   (316k -> 192k) and the cache isn't shared;
 * - tool_choice:"none" -> tools and past reasoning dropped as well (192k), cache not shared;
 * - response_format=json_object -> same size but a different prefix, cache almost all misses.
 * So only `reasoning` (mapped through streamSimple like the main loop), sessionId and cacheRetention
 * are set. "No tools, JSON only" is enforced by the instruction; on non-compliance the caller falls
 * back to segment. maxTokens is not set either (see below).
 */
function buildForkRequest(
  llm: any[],
  instruction: string,
  opts: { systemPrompt?: string; sessionId?: string; thinkingLevel?: string } = {},
): { context: any; options: any } {
  const context: any = { messages: [...llm, userInstructionMessage(instruction)] };
  // Only add systemPrompt when the projection has no leading system message (else it gets prepended twice)
  if (llm[0]?.role !== "system" && opts.systemPrompt) context.systemPrompt = opts.systemPrompt;
  // No maxTokens: the main loop sends none (pi uses the model's limit), and a smaller cap makes pi shrink
  // the thinking budget to fit, which changes the thinking parameters and breaks cache sharing
  const options: any = {
    cacheRetention: "short",
    sessionId: opts.sessionId,
  };
  if (opts.thinkingLevel && opts.thinkingLevel !== "off") options.reasoning = opts.thinkingLevel;
  return { context, options };
}

/** Segment request: the excerpt as the user message, this extension's prompt as the system prompt. */
function buildSegmentRequest(segment: string, charLimit: number, manual = false): { context: any; options: any } {
  return {
    context: { systemPrompt: buildInstruction(CANDIDATES, charLimit, manual), messages: [userInstructionMessage(segment)] },
    options: { cacheRetention: "none" },
  };
}

/**
 * Build the fork request context; undefined when unavailable.
 * Like the main loop, only `{ messages }` is sent (tool declarations live in the leading system
 * message's toolsAdded). Passing systemPrompt as well would make pi prepend a second system message,
 * shifting the whole prefix and missing the cache.
 */
function forkContext(
  ctx: ExtensionContext,
  instruction: string,
): { context: any; options: any } | undefined {
  let projection: any;
  try {
    // convertToLlm turns pi-internal compactionSummary/custom/system entries into model messages
    projection = (ctx.sessionManager as any).buildSessionProjection();
  } catch {
    return undefined;
  }
  if (!projection || !Array.isArray(projection.messages) || projection.messages.length === 0) return undefined;
  const llm = convertToLlm(projection.messages);
  let thinkingLevel: string | undefined;
  try {
    thinkingLevel = piApi?.getThinkingLevel();
  } catch {
    thinkingLevel = undefined;
  }
  return buildForkRequest(llm, instruction, {
    systemPrompt: ctx.getSystemPrompt(),
    sessionId: ctx.sessionManager.getSessionId(),
    thinkingLevel,
  });
}

/** Send one request and parse candidates. simple=true uses streamSimple like the main loop (thinking level mapping). */
async function completeCards(
  ctx: ExtensionContext,
  model: any,
  context: any,
  options: any,
  limit: number,
  simple = false,
): Promise<{ cards: string[]; usage?: any; aborted: boolean; parsed: boolean; error?: string; stop?: string; text?: string }> {
  const registry: any = ctx.modelRegistry;
  const res: any =
    simple && typeof registry.streamSimple === "function"
      ? await registry.streamSimple(model, context, options).result()
      : await ctx.modelRegistry.complete(model, context, options);
  const usage = (res as any).usage;
  const stop = res.stopReason;
  if (res.stopReason === "aborted") return { cards: [], usage, aborted: true, parsed: false, stop };
  if (res.stopReason === "error") return { cards: [], usage, aborted: false, parsed: false, error: (res as any).errorMessage ?? "error", stop };
  // The model tried to call a tool = did not comply (the call is never executed; treated as a failure)
  if (res.stopReason === "toolUse") return { cards: [], usage, aborted: false, parsed: false, stop };
  const text = res.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  const { cards, parsed } = parseOutput(text, limit, cardCharLimit());
  return { cards, usage, aborted: false, parsed, stop, text };
}

async function generateCards(ctx: ExtensionContext, signal: AbortSignal, manual = false): Promise<string[]> {
  // Automatic suggestions wait for two replies; a manual Tab request only needs one
  if (assistantTurns(ctx) < (manual ? 1 : MIN_ASSISTANT_TURNS)) return [];

  const limit = CANDIDATES;
  const charLimit = cardCharLimit();
  const session = ctx.sessionManager.getSessionId();

  // 1) fork: replay the full real context with the prediction instruction appended.
  //    Always the session model: another model can't share the cache, so fork would be a second big session.
  const model: any = ctx.model;
  const base = { session, model: model ? `${model.provider}/${model.id}` : undefined };
  const skip = model ? forkSkipReason(ctx) : "no_session_model";
  if (skip !== null) logEvent({ ...base, path: "fork", skipped: skip });
  else {
    const fork = forkContext(ctx, buildForkInstruction(limit, charLimit, manual));
    if (!fork) logEvent({ ...base, path: "fork", skipped: "no_context" });
    else {
      const t0 = Date.now();
      try {
        const r = await completeCards(ctx, model, fork.context, { ...fork.options, signal }, limit, true);
        logEvent({
          ...base, path: "fork", ms: Date.now() - t0, reasoning: fork.options.reasoning ?? "off",
          msgs: fork.context.messages.length, stop: r.stop, parsed: r.parsed, cards: r.cards,
          usage: usageBrief(r.usage), error: r.error, ...(r.parsed ? {} : { textHead: r.text?.slice(0, 120) }),
        });
        if (!r.aborted) recordForkOutcome(r.usage); // large request with zero hits -> stop forking this session
        // The model complied (returned JSON, even a deliberate empty list) -> use it; otherwise fall back to segment
        if (r.parsed) return r.cards;
        if (signal.aborted) return [];
      } catch (err) {
        // fork failed (incompatible context / unsupported API) -> fall back to segment
        logEvent({ ...base, path: "fork", ms: Date.now() - t0, exception: String((err as any)?.message ?? err).slice(0, 200) });
      }
    }
  }

  // 2) segment (the configured mode, or fork's fallback: fork off, oversized context or failed fork)
  //    -> lightweight excerpt with the segment model
  const segModel = resolveSegmentModel(ctx);
  if (!segModel) {
    logEvent({ session, path: "segment", skipped: "no_segment_model" });
    return [];
  }
  const segment = lastTurnSegment(ctx);
  if (!segment) return [];
  const seg = buildSegmentRequest(segment, charLimit, manual);
  const t1 = Date.now();
  const r = await completeCards(ctx, segModel, seg.context, { ...seg.options, signal }, limit);
  logEvent({ session, model: `${segModel.provider}/${segModel.id}`, path: "segment", ms: Date.now() - t1, stop: r.stop, parsed: r.parsed, cards: r.cards, usage: usageBrief(r.usage), error: r.error });
  return r.cards;
}

// ---------------------------------------------------------------------------
// Ghost text in the input box: one suggestion; Tab accepts, Esc dismisses, typing hides it until the box is empty again
// ---------------------------------------------------------------------------

/** End marker of the editor's fake cursor (see pi-tui tui.js FAKE_CURSOR_END) */
const FAKE_CURSOR_END = "\x1b_pi:/fc\x07";
/** Maximum lines the ghost text may take (truncated with … beyond that) */
const GHOST_MAX_LINES = 3;
/** Marks our editor factory so a reloaded module instance can recognize the old one */
const GHOST_FACTORY_TAG = "__promptSuggestionGhostEditor";

let ghostText: string | undefined;
let ghostTui: { requestRender(): void } | undefined;
/** Set by the patched render once the ghost text was actually drawn inside the editor */
let ghostDrawn = false;
/** A Tab-triggered generation is running; the editor shows a dimmed placeholder meanwhile */
let ghostPending = false;
const PENDING_TEXT = "Generating suggestion…";
/** Latest extension context (for Tab-triggered generation from inside the editor) */
let activeCtx: ExtensionContext | undefined;
/** Context of the "drawn above the editor" safety-net line, so clearGhost can remove it */
let ghostLineCtx: ExtensionContext | undefined;
let ghostDim: (s: string) => string = (s) => `\x1b[2m${s}\x1b[22m`;
/** Fallback when the editor can't be wrapped: one dimmed line above the editor + terminal input hook */
let ghostFallback: { ctx: ExtensionContext; unsubscribe: () => void } | undefined;

/** Split by display width: first line firstW, following lines restW, at most maxLines (last one gets …) */
function splitByWidth(text: string, firstW: number, restW: number, maxLines: number): string[] {
  const out: string[] = [];
  let cur = "";
  let w = 0;
  let limit = firstW;
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const cw = visibleWidth(chars[i]);
    if (w + cw > limit) {
      if (out.length === maxLines - 1) {
        out.push(truncateToWidth(cur + chars.slice(i).join(""), limit));
        return out;
      }
      out.push(cur);
      cur = "";
      w = 0;
      limit = restW;
    }
    cur += chars[i];
    w += cw;
  }
  out.push(cur);
  return out;
}

/** Replace the blank space after the cursor in the editor's rendered lines with ghost text (empty editor only) */
function injectGhost(lines: string[], ghost: string, width: number, paddingX: number): string[] {
  const i = lines.findIndex((l) => l.includes(FAKE_CURSOR_END));
  if (i < 0) return lines;
  const line = lines[i];
  const k = line.lastIndexOf(FAKE_CURSOR_END) + FAKE_CURSOR_END.length;
  const tail = line.slice(k);
  if (/[^ ]/.test(tail)) return lines; // something after the cursor (editor not empty) -> leave as is
  const firstW = tail.length - paddingX;
  const restW = width - 2 * paddingX - 1;
  if (firstW < 4 || restW < 4) return lines;
  const parts = splitByWidth(ghost, firstW, restW, GHOST_MAX_LINES);
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));
  const rightPad = " ".repeat(paddingX);
  const injected = [line.slice(0, k) + ghostDim(parts[0]) + pad("", firstW - visibleWidth(parts[0])) + rightPad];
  const indent = " ".repeat(paddingX + 1);
  for (const p of parts.slice(1)) injected.push(indent + ghostDim(p) + pad("", restW - visibleWidth(p)) + rightPad);
  return [...lines.slice(0, i), ...injected, ...lines.slice(i + 1)];
}

/** Identity of this module instance: wrappers from a pre-/reload module get unwrapped and rewrapped */
const GHOST_MODULE_TOKEN = Symbol("prompt-suggestion-ghost");

/**
 * Add ghost text to any editor instance by wrapping its own render/handleInput (including versions
 * already patched by other extensions). Dimmed text is injected after the cursor only when the editor
 * is empty and a suggestion exists; Tab accepts, Esc dismisses, other keys only hide it while there is text.
 */
function patchGhost(ed: any) {
  if (!ed || ed.__promptSuggestionGhostPatched) return;
  ed.__promptSuggestionGhostPatched = true;
  const origRender = ed.render.bind(ed);
  const origInput = ed.handleInput.bind(ed);
  ed.render = (width: number): string[] => {
    const lines = origRender(width);
    const g = ghostText ?? (ghostPending ? PENDING_TEXT : undefined);
    if (g === undefined || ed.getText() !== "") return lines;
    const out = injectGhost(lines, g, width, typeof ed.getPaddingX === "function" ? ed.getPaddingX() : 0);
    if (out !== lines && ghostText !== undefined) ghostDrawn = true;
    return out;
  };
  ed.handleInput = (data: string): void => {
    const empty = ed.getText() === "";
    if (ghostText !== undefined) {
      // Tab/Esc act on the suggestion only while it is visible (empty editor)
      if (empty && matchesKey(data, Key.tab)) {
        // Accept: put it in the editor (cursor at the end, editable before Enter). The suggestion is
        // kept, hidden while there is text, so deleting the accepted text brings it back.
        ed.setText(ghostText);
        afterEditorInput();
        return;
      }
      if (empty && matchesKey(data, Key.escape)) {
        clearGhost(); // Esc dismisses for good, no other action
        return;
      }
      // Any other key: keep the suggestion. It hides while the editor has text and
      // comes back when the editor is cleared; it is discarded on submit or a new turn.
    } else if (ghostPending) {
      if (empty && matchesKey(data, Key.tab)) return; // already generating
      if (empty && matchesKey(data, Key.escape)) {
        cancelSuggestion(); // Esc cancels the generation
        return;
      }
      // typing keeps the generation running; the result shows once the editor is empty
    } else if (empty && matchesKey(data, Key.tab) && canTriggerByTab()) {
      triggerNow();
      return;
    }
    origInput(data);
    afterEditorInput();
  };
}

/**
 * Wrap an editor factory: inner is the factory currently in effect (possibly another extension's,
 * e.g. pi-powerline-footer), or pi's default CustomEditor when there is none. This layers on top of
 * other extensions that replace the editor instead of overriding them.
 */
function wrapEditorFactory(inner: any): any {
  const f: any = (tui: any, theme: any, keybindings: any) => {
    const ed = inner ? inner(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
    ghostTui = tui;
    patchGhost(ed);
    return ed;
  };
  f[GHOST_FACTORY_TAG] = true;
  f.__promptSuggestionInner = inner;
  f.__promptSuggestionModule = GHOST_MODULE_TOKEN;
  return f;
}

/**
 * Wrap every editor anyone installs from now on. ctx.ui is one object shared by all extensions, so
 * hooking its setEditorComponent catches other extensions' swaps (pi-powerline-footer reinstalls its
 * editor at session start and on the first keypress after a start or /reload) at the source, instead of
 * finding an unwrapped editor later. The true original is kept on the object so a reloaded module rehooks it.
 */
function hookEditorInstalls(ui: any) {
  if (typeof ui?.setEditorComponent !== "function" || ui.__promptSuggestionHook === GHOST_MODULE_TOKEN) return;
  const original = ui.__promptSuggestionOrigSet ?? ui.setEditorComponent.bind(ui);
  ui.__promptSuggestionOrigSet = original;
  ui.__promptSuggestionHook = GHOST_MODULE_TOKEN;
  ui.setEditorComponent = (factory: any) => {
    const inner = factory?.[GHOST_FACTORY_TAG] ? factory.__promptSuggestionInner : factory;
    original(wrapEditorFactory(inner));
  };
}

/** Make sure the current editor shows ghost text; rewrap if another extension swapped it. False = can't take over. */
function ensureGhostEditor(ctx: ExtensionContext): boolean {
  const ui: any = ctx.ui;
  if (typeof ui.setEditorComponent !== "function") return false;
  const current = ui.getEditorComponent?.();
  if (current?.[GHOST_FACTORY_TAG] && current.__promptSuggestionModule === GHOST_MODULE_TOKEN) return true;
  // A wrapper from an older module instance (before /reload): unwrap and rewrap; otherwise wrap the current factory
  const inner = current?.[GHOST_FACTORY_TAG] ? current.__promptSuggestionInner : current;
  ui.setEditorComponent(wrapEditorFactory(inner));
  return true;
}

function clearGhost() {
  if (ghostText === undefined && !ghostPending && !ghostFallback && !ghostLineCtx) return;
  ghostText = undefined;
  ghostPending = false;
  if (ghostLineCtx) {
    ghostLineCtx.ui.setWidget(WIDGET_KEY, undefined);
    ghostLineCtx = undefined;
  }
  if (ghostFallback) {
    const { ctx, unsubscribe } = ghostFallback;
    ghostFallback = undefined;
    unsubscribe();
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  }
  ghostTui?.requestRender();
}

/** Key handling for the fallback line: Tab accepts, Esc dismisses (both only while the box is empty); other keys pass through. */
function onFallbackInput(data: string): { consume?: boolean } | undefined {
  const fb = ghostFallback;
  const g = ghostText;
  if (!fb || g === undefined) return undefined;
  const empty = fb.ctx.ui.getEditorText() === "";
  if (empty && matchesKey(data, Key.tab)) {
    fb.ctx.ui.setEditorText(g); // kept (hidden) so deleting the accepted text brings it back
    setTimeout(syncGhostLine, 0);
    return { consume: true };
  }
  if (empty && matchesKey(data, Key.escape)) {
    clearGhost();
    return { consume: true };
  }
  // Other keys go to the editor; afterwards show/hide the line depending on whether it is empty
  setTimeout(syncGhostLine, 0);
  return undefined;
}

/** The "(Tab to accept)" line used when the suggestion can't be drawn inside the editor */
function ghostLine(text: string): string[] {
  return [ghostDim(` ${truncateToWidth(text, 200)}  (Tab to accept)`)];
}

/** Line mode (fallback / safety net): show the line only while the editor is empty */
function syncGhostLine() {
  const ctx = ghostFallback?.ctx ?? ghostLineCtx;
  if (!ctx) return;
  const show = ghostText !== undefined && ctx.ui.getEditorText() === "";
  ctx.ui.setWidget(WIDGET_KEY, show && ghostText !== undefined ? ghostLine(ghostText) : undefined, { placement: "aboveEditor" });
}

/**
 * Safety net: shortly after the suggestion should have been drawn inline, check that it was. If the
 * editor in use can't show it (no fake cursor in its output), switch to the line above the editor;
 * Tab/other keys are still handled by the patched editor. Only decidable while the editor is empty,
 * so it is re-run when the editor becomes empty again.
 */
function scheduleInlineCheck(ctx: ExtensionContext, text: string) {
  setTimeout(() => {
    if (ghostText !== text || ghostDrawn || ghostLineCtx || ghostFallback) return;
    if (ctx.ui.getEditorText() !== "") return;
    ghostLineCtx = ctx;
    syncGhostLine();
  }, 150);
}

/** After the patched editor handled a key: keep line mode in sync and re-check inline drawing when emptied */
function afterEditorInput() {
  if (ghostText === undefined) return;
  syncGhostLine();
  const ctx = activeCtx;
  if (ctx && !ghostDrawn && !ghostLineCtx) {
    try {
      if (ctx.ui.getEditorText() === "") scheduleInlineCheck(ctx, ghostText);
    } catch {
      // stale context
    }
  }
}

function showGhost(ctx: ExtensionContext, text: string) {
  clearGhost();
  // Set it even if the user is typing: it stays hidden until the editor is empty
  try {
    const t = ctx.ui.theme as any;
    if (typeof t?.fg === "function") ghostDim = (s) => t.fg("dim", s);
  } catch {
    // keep the default ANSI dim
  }
  ghostText = text;
  ghostDrawn = false;
  if (ensureGhostEditor(ctx)) {
    ghostTui?.requestRender();
    scheduleInlineCheck(ctx, text);
    return;
  }
  const unsubscribe = ctx.ui.onTerminalInput(onFallbackInput);
  ghostFallback = { ctx, unsubscribe };
  syncGhostLine();
}

/** Generate and show one suggestion as ghost text; Tab puts it in the editor. Only while still idle. */
async function runSuggestion(ctx: ExtensionContext, manual = false) {
  if (!ctx.isIdle() || !canGenerate(ctx)) return;
  const ac = new AbortController();
  inflight = ac;
  let items: string[] = [];
  try {
    items = await generateCards(ctx, ac.signal, manual);
  } catch {
    // generation errors are ignored; they must not affect the session
  } finally {
    if (inflight === ac) inflight = undefined;
  }
  if (ac.signal.aborted) return; // cancelled: cancelSuggestion already cleared the placeholder
  if (manual) {
    ghostPending = false;
    ghostTui?.requestRender();
  }
  if (items.length === 0 || !ctx.isIdle()) {
    if (manual && items.length === 0) ctx.ui.notify("No suggestion right now", "info");
    return;
  }

  showGhost(ctx, items[0]);
}

/** Whether Tab in an empty editor should generate now */
function canTriggerByTab(): boolean {
  const ctx = activeCtx;
  try {
    if (!ctx || !ctx.hasUI || !ctx.isIdle() || inflight) return false;
  } catch {
    return false; // stale context
  }
  const cfg = loadConfig();
  // Segment mode without a segment model generates nothing: leave Tab to the editor
  return cfg.tabToGenerate !== false && !!ctx && canGenerate(ctx);
}

/** Generate immediately (Tab in an empty editor): skip the idle delay and show a placeholder meanwhile */
function triggerNow() {
  const ctx = activeCtx;
  if (!ctx) return;
  cancelTimer();
  clearGhost();
  ghostPending = true;
  ghostTui?.requestRender();
  void runSuggestion(ctx, true);
}

// ---------------------------------------------------------------------------
// Settings: /suggestion opens it; every change is saved to prompt-suggestion.json in pi's agent dir at once
// ---------------------------------------------------------------------------

/** One option of a setting: label is shown, value is written (undefined = remove the key, use the default) */
interface Choice {
  label: string;
  value: unknown;
}

interface SettingDef {
  id: keyof SuggestionConfig;
  label: string;
  description: string;
  choices: (cfg: SuggestionConfig) => Choice[];
}

const ON_OFF = (dflt: boolean): Choice[] => [
  { label: "on", value: dflt ? undefined : true },
  { label: "off", value: dflt ? false : undefined },
];

/** Numeric presets; a current value outside the presets is added so it displays as is */
function numChoices(presets: number[], current: number | undefined, dflt: number, fmt: (n: number) => string): Choice[] {
  const list = [...presets];
  if (current !== undefined && Number.isFinite(current) && !list.includes(current)) list.push(current);
  list.sort((a, b) => a - b);
  return list.map((n) => ({ label: fmt(n) + (n === dflt ? " (default)" : ""), value: n === dflt ? undefined : n }));
}

const SETTINGS: SettingDef[] = [
  {
    id: "context",
    label: "Context mode",
    description: "fork: full session with the session model, reuses the session's prompt cache, best quality. segment: short excerpt with the segment model, cheap and fast. While the cache is cold or expired, segment is used; fork resumes once the conversation warms the cache again",
    choices: () => [
      { label: "fork (default)", value: undefined },
      { label: "segment", value: "segment" },
    ],
  },
  {
    id: "segmentModel",
    label: "Segment model",
    description: "Model for segment requests (segment mode and fork's fallback). Not set: segment mode generates nothing and fork has no fallback. Fork always uses the session model (Enter opens the list)",
    choices: (cfg) => [{ label: UNSET_MODEL_LABEL, value: undefined }, ...(cfg.segmentModel ? [{ label: cfg.segmentModel, value: cfg.segmentModel }] : [])],
  },
  {
    id: "tabToGenerate",
    label: "Tab to generate",
    description: "Press Tab in an empty input box to generate a suggestion immediately, without waiting for the idle delay",
    choices: () => ON_OFF(true),
  },
  {
    id: "delaySeconds",
    label: "Idle delay",
    description: "How long the input box must stay idle after a turn before generating. off: no automatic suggestions (Tab still generates one)",
    choices: (cfg) =>
      numChoices([0, 5, 10, 15, 20, 30, 45, 60, 120, 300, 600], cfg.delaySeconds, DEFAULT_DELAY_SECONDS, (n) => (n === 0 ? "off" : `${n}s`)),
  },
  {
    id: "maxCardChars",
    label: "Max length",
    description: "Suggestions longer than this many characters are discarded",
    choices: (cfg) => numChoices([20, 30, 40, 50, 60, 80, 100], cfg.maxCardChars, DEFAULT_MAX_CARD_CHARS, (n) => `${n} chars`),
  },
  {
    id: "cacheTtlSeconds",
    label: "Cache freshness",
    description: "If the last reply is older than this, the cache is treated as expired and segment is used until the next turn warms it",
    choices: (cfg) =>
      numChoices([0, 60, 120, 300, 600, 1800, 3600], cfg.cacheTtlSeconds, DEFAULT_CACHE_TTL_SECONDS, (n) => (n === 0 ? "no check" : `${n}s`)),
  },
  {
    id: "maxForkTokens",
    label: "Fork context limit",
    description: "Skip fork when the session exceeds this many tokens (with cache hits large contexts are cheap; usually no limit needed)",
    choices: (cfg) =>
      numChoices([0, 50_000, 100_000, 200_000, 400_000, 800_000], cfg.maxForkTokens, DEFAULT_MAX_FORK_TOKENS, (n) => (n === 0 ? "unlimited" : `${n / 1000}k`)),
  },
  {
    id: "debugLog",
    label: "Diagnostic log",
    description: `Write each generation's path and usage to ${DEFAULT_LOG_PATH}`,
    choices: () => ON_OFF(false),
  },
];

/** Display label for a setting's current value */
function currentLabel(def: SettingDef, cfg: SuggestionConfig): string {
  const v = cfg[def.id];
  const choices = def.choices(cfg);
  return (choices.find((c) => c.value === v) ?? choices.find((c) => c.value === undefined) ?? choices[0]).label;
}

/** Write one setting (value undefined = remove the key, back to default) */
function applySetting(id: keyof SuggestionConfig, value: unknown) {
  const cfg: any = loadConfig();
  if (value === undefined) delete cfg[id];
  else cfg[id] = value;
  saveConfig(cfg);
  if (id === "delaySeconds" && value === undefined) cancelTimer(); // back to the default (off)
}

function openSettings(ctx: ExtensionContext): Promise<void> {
  return ctx.ui.custom<void>((tui, _theme, _kb, done) => {
    const cfg = loadConfig();
    const items: SettingItem[] = SETTINGS.map((def) => {
      const item: SettingItem = {
        id: def.id,
        label: def.label,
        description: def.description,
        currentValue: currentLabel(def, cfg),
        values: def.choices(cfg).map((c) => c.label),
      };
      if (def.id === "segmentModel") {
        delete item.values;
        item.submenu = (currentValue, close) => {
          const labels = [UNSET_MODEL_LABEL, ...ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`)];
          const list = new SelectList(
            labels.map((l) => ({ value: l, label: l })),
            Math.min(labels.length, 12),
            getSelectListTheme(),
          );
          const idx = labels.indexOf(currentValue);
          if (idx > 0) list.setSelectedIndex?.(idx);
          list.onSelect = (it) => close(it.value);
          list.onCancel = () => close();
          return list;
        };
      }
      return item;
    });

    const settings = new SettingsList(
      items,
      Math.min(items.length, 12),
      getSettingsListTheme(),
      (id, label) => {
        const def = SETTINGS.find((d) => d.id === id);
        if (!def) return;
        if (id === "segmentModel") applySetting("segmentModel", label === UNSET_MODEL_LABEL ? undefined : label);
        else {
          const choice = def.choices(loadConfig()).find((c) => c.label === label);
          if (choice) applySetting(def.id, choice.value);
        }
        // Some labels depend on the saved config (e.g. default markers); refresh all
        const fresh = loadConfig();
        for (const d of SETTINGS) settings.updateValue(d.id, currentLabel(d, fresh));
        tui.requestRender();
      },
      () => done(),
    );

    const panel = new Container();
    panel.addChild(new DynamicBorder());
    panel.addChild(new Text(ctx.ui.theme.bold(ctx.ui.theme.fg("accent", " Prompt suggestion settings")), 0, 0));
    panel.addChild(new Text(ctx.ui.theme.fg("muted", " ↑↓ select · Enter/Space change · Esc close · changes are saved immediately"), 0, 0));
    panel.addChild(new Spacer(1));
    panel.addChild(settings);
    panel.addChild(new DynamicBorder());
    return Object.assign(panel, { handleInput: (data: string) => settings.handleInput(data) });
  });
}

export default function promptSuggestion(pi: ExtensionAPI) {
  piApi = pi;
  pi.on("session_start", (_event, ctx) => {
    resetForkState();
    cancelSuggestion();
    activeCtx = ctx;
    // Install the ghost-text editor early (the editor resets to default when extension UI is reset),
    // and wrap any editor other extensions install later
    if (ctx.hasUI && ctx.mode === "tui") {
      hookEditorInstalls(ctx.ui);
      ensureGhostEditor(ctx);
    }
  });
  pi.on("session_shutdown", () => {
    resetForkState();
    cancelSuggestion();
    activeCtx = undefined;
  });
  pi.on("agent_start", () => cancelSuggestion());

  // /suggestion: settings (enable switch + all parameters), saved immediately
  pi.registerCommand("suggestion", {
    description: "Prompt suggestion settings: enable, mode, model, delay, length, ...",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      await openSettings(ctx);
    },
  });

  // After a turn fully settles, wait for the idle delay before generating (not after a user abort)
  pi.on("agent_settled", (event, ctx) => {
    if (event.aborted || !ctx.hasUI || ctx.mode !== "tui") return;
    activeCtx = ctx;
    cancelTimer();
    // Other extensions (e.g. pi-powerline-footer) may reinstall their editor at any time; rewrap so
    // Tab-to-generate and ghost text keep working on the editor actually in use
    ensureGhostEditor(ctx);
    const delay = delayMs();
    if (delay === undefined) return; // automatic suggestions off; Tab still generates one
    timer = setTimeout(() => {
      timer = undefined;
      void runSuggestion(ctx);
    }, delay);
  });

  // Any user input cancels a pending or in-flight suggestion
  pi.on("input", (event) => {
    if (event.source !== "extension") cancelSuggestion();
    return { action: "continue" };
  });
}

// Named exports for test scripts; pi only uses the default export.
export {
  CANDIDATES, triggerNow, canTriggerByTab, injectGhost, patchGhost, wrapEditorFactory, showGhost, clearGhost,
  buildInstruction, buildForkInstruction, buildForkRequest, buildSegmentRequest, lastTurnSegment, rejectReason,
  generateCards, wordCount, cacheIsWarm, cacheState, canGenerate, delayMs, forkSkipReason, resetForkState, recordForkOutcome, parseOutput, cardCharLimit,
};
