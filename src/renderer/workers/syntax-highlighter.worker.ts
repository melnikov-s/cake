import { createBundledHighlighter } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import {
  syntaxThemes,
  type SupportedSyntaxLanguage,
  type SyntaxHighlightRequest,
  type SyntaxHighlightResponse,
} from "../lib/syntax-highlighter-contract";

const createSyntaxHighlighter = createBundledHighlighter({
  engine: () => createOnigurumaEngine(import("shiki/wasm")),
  langs: {
    c: () => import("@shikijs/langs/c"),
    cpp: () => import("@shikijs/langs/cpp"),
    css: () => import("@shikijs/langs/css"),
    go: () => import("@shikijs/langs/go"),
    html: () => import("@shikijs/langs/html"),
    java: () => import("@shikijs/langs/java"),
    javascript: () => import("@shikijs/langs/javascript"),
    jsx: () => import("@shikijs/langs/jsx"),
    json: () => import("@shikijs/langs/json"),
    markdown: () => import("@shikijs/langs/markdown"),
    mdx: () => import("@shikijs/langs/mdx"),
    php: () => import("@shikijs/langs/php"),
    python: () => import("@shikijs/langs/python"),
    ruby: () => import("@shikijs/langs/ruby"),
    rust: () => import("@shikijs/langs/rust"),
    scss: () => import("@shikijs/langs/scss"),
    shellscript: () => import("@shikijs/langs/shellscript"),
    sql: () => import("@shikijs/langs/sql"),
    svelte: () => import("@shikijs/langs/svelte"),
    typescript: () => import("@shikijs/langs/typescript"),
    tsx: () => import("@shikijs/langs/tsx"),
    vue: () => import("@shikijs/langs/vue"),
    xml: () => import("@shikijs/langs/xml"),
    yaml: () => import("@shikijs/langs/yaml"),
  },
  themes: {
    "github-dark": () => import("@shikijs/themes/github-dark"),
    "github-light-high-contrast": () => import("@shikijs/themes/github-light-high-contrast"),
  },
});

type SyntaxHighlighter = Awaited<ReturnType<typeof createSyntaxHighlighter>>;

type SyntaxWorkerScope = {
  onmessage: ((event: MessageEvent<SyntaxHighlightRequest>) => void) | null;
  postMessage(message: SyntaxHighlightResponse): void;
};

// SAFETY: Vite instantiates this entry only as a dedicated module worker, whose global scope
// provides the one-argument postMessage and worker message handler represented here.
const scope = globalThis as SyntaxWorkerScope;

let highlighterPromise: Promise<SyntaxHighlighter> | undefined;
const languageLoads = new Map<string, Promise<void>>();

function getHighlighter() {
  highlighterPromise ??= createSyntaxHighlighter({
    langs: [],
    themes: [...syntaxThemes],
  });
  return highlighterPromise;
}

async function loadLanguage(highlighter: SyntaxHighlighter, language: SupportedSyntaxLanguage) {
  if (highlighter.getLoadedLanguages().includes(language)) return;
  let load = languageLoads.get(language);
  if (!load) {
    load = highlighter.loadLanguage(language);
    languageLoads.set(language, load);
  }
  await load;
}

let queue = Promise.resolve();

async function highlight(request: SyntaxHighlightRequest) {
  try {
    const highlighter = await getHighlighter();
    const coldLanguage = !highlighter.getLoadedLanguages().includes(request.language);
    const loadStartedAt = performance.now();
    await loadLanguage(highlighter, request.language);
    const loadMs = performance.now() - loadStartedAt;
    const tokenizeStartedAt = performance.now();
    const result = highlighter.codeToTokens(request.code, {
      lang: request.language,
      themes: { light: syntaxThemes[0], dark: syntaxThemes[1] },
      tokenizeMaxLineLength: 2_000,
      tokenizeTimeLimit: 100,
    });
    const tokenizeMs = performance.now() - tokenizeStartedAt;
    scope.postMessage({
      id: request.id,
      result,
      metrics: { coldLanguage, loadMs, tokenizeMs },
    });
  } catch (reason) {
    scope.postMessage({
      id: request.id,
      error: reason instanceof Error ? reason.message : String(reason),
    });
  }
}

scope.onmessage = (event) => {
  const request = event.data;
  queue = queue.then(() => highlight(request));
};
