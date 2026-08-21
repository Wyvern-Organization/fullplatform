type Entry = { model: string; tokens: string[]; tokenSet: Set<string>; size: number; answer: string; createdAt: number; hits: number };

const entries: Entry[] = [];
const MAX_ENTRIES = 256;
const TTL_MS = 15 * 60_000;
// Pre-compiled regexes avoid re-creating on hot path
const NON_ALNUM_RE = /[^\p{L}\p{N}\s]/gu;
const PERSONAL_RE = /(\bmy\b|\bme\b|\bi\b|\bwe\b|\bour\b|@|https?:\/\/|www\.|\+?\d[\d ().-]{7,}\d|```)/i;

function tokens(input: string): string[] {
  // hot path: single pass lower + replace, cheap split, dedup via Set
  return [...new Set(input.toLowerCase().replace(NON_ALNUM_RE, " ").split(/\s+/).filter((word) => word.length > 1))].slice(0, 80);
}

export function cacheablePrompt(input: string): boolean {
  if (input.length < 12 || input.length > 4_000) return false;
  return !PERSONAL_RE.test(input);
}

export function getSemanticCache(model: string, prompt: string): string | null {
  if (!cacheablePrompt(prompt)) return null;
  const wanted = tokens(prompt);
  if (wanted.length < 3) return null;
  const wantedSet = new Set(wanted);
  const wantedSize = wantedSet.size;
  const now = Date.now();
  let best: Entry | undefined;
  let bestScore = 0;
  // single backward pass: evict expired + score in one loop, no extra Set alloc for union
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (now - entry.createdAt > TTL_MS) { entries.splice(i, 1); continue; }
    if (entry.model !== model) continue;
    // fast overlap using precomputed Set
    let overlap = 0;
    for (const t of wanted) if (entry.tokenSet.has(t)) overlap++;
    if (overlap === 0) continue;
    const union = wantedSize + entry.size - overlap;
    const score = overlap / union;
    if (score > bestScore) { bestScore = score; best = entry; if (score >= 0.95) break; }
  }
  if (!best || bestScore < 0.72) return null;
  best.hits += 1;
  return best.answer;
}

export function putSemanticCache(model: string, prompt: string, answer: string): void {
  if (!cacheablePrompt(prompt) || !answer.trim() || answer.length > 20_000) return;
  const toks = tokens(prompt);
  entries.push({ model, tokens: toks, tokenSet: new Set(toks), size: new Set(toks).size, answer, createdAt: Date.now(), hits: 0 });
  // ring-buffer style eviction: shift is O(n) but n<=256, amortized cheap; use splice 0,1 for clarity
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

