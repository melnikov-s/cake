import type { CodeHighlighterPlugin } from "streamdown";
import {
  maxHighlightCharacters,
  supportedSyntaxLanguages,
  syntaxThemes,
  type SupportedSyntaxLanguage,
  type SyntaxHighlightRequest,
  type SyntaxHighlightResponse,
  type SyntaxHighlightResult,
} from "./syntax-highlighter-contract";

export type { SyntaxHighlightResult } from "./syntax-highlighter-contract";

const aliases = new Map<string, SupportedSyntaxLanguage>([
  ["bash", "shellscript"],
  ["cc", "cpp"],
  ["cjs", "javascript"],
  ["cts", "typescript"],
  ["htm", "html"],
  ["js", "javascript"],
  ["md", "markdown"],
  ["mjs", "javascript"],
  ["mts", "typescript"],
  ["py", "python"],
  ["rb", "ruby"],
  ["rs", "rust"],
  ["sh", "shellscript"],
  ["svg", "xml"],
  ["ts", "typescript"],
  ["yml", "yaml"],
]);
const supportedLanguages = new Set<string>(supportedSyntaxLanguages);

function normalizeLanguage(language: string) {
  const normalized = language.trim().toLowerCase();
  return aliases.get(normalized) ?? normalized;
}

function isSupportedLanguage(language: string): language is SupportedSyntaxLanguage {
  return supportedLanguages.has(language);
}

function plainResult(code: string): SyntaxHighlightResult {
  let offset = 0;
  return {
    tokens: code.split("\n").map((content) => {
      const tokenOffset = offset;
      offset += content.length + 1;
      return content ? [{ content, offset: tokenOffset }] : [];
    }),
  };
}

// Transcript rows are virtualized, so scrolling unmounts and remounts their code
// blocks. Keep a transcript-sized working set: an undersized cache makes every
// revisit briefly render plain text and enqueue the same expensive tokenization
// again. The weight limit still bounds unusually large token results.
const maximumCacheEntries = 512;
const maximumCacheWeight = 64 * 1024 * 1024;
const resultCache = new Map<string, { result: SyntaxHighlightResult; weight: number }>();
let resultCacheWeight = 0;

function cacheWeight(code: string, result: SyntaxHighlightResult) {
  let tokenCount = 0;
  for (const line of result.tokens) tokenCount += line.length;
  // Count both the cache key's source string and the token objects. This is an
  // intentionally conservative estimate rather than an expensive serialization.
  return code.length * 4 + tokenCount * 96;
}

function cachedResult(key: string) {
  const cached = resultCache.get(key);
  if (!cached) return undefined;
  resultCache.delete(key);
  resultCache.set(key, cached);
  return cached.result;
}

function cacheResult(key: string, code: string, result: SyntaxHighlightResult) {
  const weight = cacheWeight(code, result);
  if (weight > maximumCacheWeight) return;
  const replaced = resultCache.get(key);
  if (replaced) resultCacheWeight -= replaced.weight;
  resultCache.set(key, { result, weight });
  resultCacheWeight += weight;
  while (resultCache.size > maximumCacheEntries || resultCacheWeight > maximumCacheWeight) {
    const oldestKey = resultCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = resultCache.get(oldestKey);
    resultCache.delete(oldestKey);
    if (oldest) resultCacheWeight -= oldest.weight;
  }
}

type PendingHighlight = {
  code: string;
  key: string;
  language: string;
  startedAt: number;
  callbacks: Set<(result: SyntaxHighlightResult) => void>;
};

let nextRequestId = 1;
let syntaxWorker: Worker | undefined;
let workerUnavailable = false;
const pendingByKey = new Map<string, PendingHighlight>();
const pendingById = new Map<number, PendingHighlight>();

function finishPending(pending: PendingHighlight, result: SyntaxHighlightResult) {
  pendingByKey.delete(pending.key);
  cacheResult(pending.key, pending.code, result);
  for (const callback of pending.callbacks) callback(result);
}

function failWorker(reason: unknown) {
  workerUnavailable = true;
  syntaxWorker?.terminate();
  syntaxWorker = undefined;
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error("[Syntax highlighter] Worker failed; using plain code rendering", message);
  for (const [id, pending] of pendingById) {
    pendingById.delete(id);
    finishPending(pending, plainResult(pending.code));
  }
}

function getSyntaxWorker() {
  if (workerUnavailable || !("Worker" in globalThis)) return undefined;
  if (syntaxWorker) return syntaxWorker;
  try {
    syntaxWorker = new Worker(new URL("../workers/syntax-highlighter.worker.ts", import.meta.url), {
      name: "cake-syntax-highlighter",
      type: "module",
    });
    syntaxWorker.addEventListener("message", (event: MessageEvent<SyntaxHighlightResponse>) => {
      const response = event.data;
      const pending = pendingById.get(response.id);
      if (!pending) return;
      pendingById.delete(response.id);
      const result = response.result ?? plainResult(pending.code);
      const elapsedMs = performance.now() - pending.startedAt;
      if (response.error) {
        console.warn("[Syntax highlighter] Highlight failed", {
          language: pending.language,
          characters: pending.code.length,
          error: response.error,
        });
      } else if (elapsedMs >= 250) {
        console.warn("[Syntax highlighter] Slow highlight", {
          language: pending.language,
          characters: pending.code.length,
          elapsedMs: Math.round(elapsedMs),
          ...response.metrics,
        });
      }
      finishPending(pending, result);
    });
    syntaxWorker.addEventListener("error", (event) => failWorker(event.error ?? event.message));
    syntaxWorker.addEventListener("messageerror", () =>
      failWorker(new Error("The syntax worker returned an unreadable message")),
    );
    return syntaxWorker;
  } catch (error) {
    failWorker(error);
    return undefined;
  }
}

export const syntaxHighlighter = {
  name: "shiki",
  type: "code-highlighter",
  getSupportedLanguages: () => [...supportedSyntaxLanguages],
  supportsLanguage: (language) => supportedLanguages.has(normalizeLanguage(language)),
  getThemes: (): [(typeof syntaxThemes)[0], (typeof syntaxThemes)[1]] => [
    syntaxThemes[0],
    syntaxThemes[1],
  ],
  highlight(options, callback?) {
    const language = normalizeLanguage(options.language);
    if (options.code.length > maxHighlightCharacters || !isSupportedLanguage(language))
      return plainResult(options.code);

    const key = `${language}\u0000${syntaxThemes[0]}\u0000${syntaxThemes[1]}\u0000${options.code}`;
    const cached = cachedResult(key);
    if (cached) return cached;

    const worker = getSyntaxWorker();
    if (!worker) return plainResult(options.code);

    const existing = pendingByKey.get(key);
    if (existing) {
      if (callback) existing.callbacks.add(callback);
      return null;
    }

    const id = nextRequestId++;
    const pending: PendingHighlight = {
      code: options.code,
      key,
      language,
      startedAt: performance.now(),
      callbacks: new Set(callback ? [callback] : []),
    };
    pendingByKey.set(key, pending);
    pendingById.set(id, pending);
    worker.postMessage({ id, code: options.code, language } satisfies SyntaxHighlightRequest);
    return null;
  },
} satisfies CodeHighlighterPlugin;
