// Per-model equivalent pricing, USD per million tokens. The Max plan is a flat
// subscription — nothing here is actually billed — but cost-equivalent dollars
// are the cleanest single metric for "how much of my plan am I burning",
// because they weight cache reads (0.1x), output (5x input), and model tier the
// same way Anthropic's own usage limits roughly do.
//
// Prices as of the claude-api skill cache (2026-06). Adjust if they change.
const PER_MTOK = {
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
  fable: { input: 10, output: 50 },
};
// Fallback for unrecognised model strings (treat as Opus-tier — conservative).
const DEFAULT_TIER = "opus";

const CACHE_WRITE_FACTOR = 1.25; // 5-minute TTL write premium
const CACHE_READ_FACTOR = 0.1; // cache reads bill at ~0.1x base input

// Map a raw model id ("claude-opus-4-8", "claude-3-5-haiku-20241022", …) to a
// pricing tier by substring — resilient to version/date suffixes.
export function modelTier(model = "") {
  const m = String(model).toLowerCase();
  if (m.includes("fable") || m.includes("mythos")) return "fable";
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return DEFAULT_TIER;
}

// Equivalent USD for one usage record. Accepts snake_case token fields as they
// appear in both the CLI result event and the Claude Code JSONL logs.
export function costFor(model, u = {}) {
  const p = PER_MTOK[modelTier(model)] || PER_MTOK[DEFAULT_TIER];
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  return (
    (input * p.input +
      output * p.output +
      cacheWrite * p.input * CACHE_WRITE_FACTOR +
      cacheRead * p.input * CACHE_READ_FACTOR) /
    1_000_000
  );
}

// Total raw tokens processed (all four components) — the "how many tokens" number.
export function totalTokens(u = {}) {
  return (
    (u.input_tokens || 0) +
    (u.output_tokens || 0) +
    (u.cache_creation_input_tokens || 0) +
    (u.cache_read_input_tokens || 0)
  );
}
