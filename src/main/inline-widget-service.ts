import { createRequire } from "node:module";
import { build, type Message, type Plugin } from "esbuild";

export type InlineWidgetLanguage = "html" | "react";
export type InlineWidgetCapability = "display" | "request";

export interface CompiledInlineWidgetDocument {
  document: string;
  token: string;
}

const require = createRequire(import.meta.url);
const d3Require = createRequire(require.resolve("d3"));
const maximumSourceBytes = 1_048_576;

/**
 * Inline widgets are generated code, so keep their dependency surface explicit.
 * D3 is useful for local SVG/canvas/DOM visualizations; the widget CSP still
 * blocks network access even when a D3 module exposes fetch helpers.
 */
const inlineWidgetSharedModules = new Set([
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "d3",
  "d3-array",
  "d3-axis",
  "d3-brush",
  "d3-chord",
  "d3-color",
  "d3-contour",
  "d3-delaunay",
  "d3-dispatch",
  "d3-drag",
  "d3-dsv",
  "d3-ease",
  "d3-fetch",
  "d3-force",
  "d3-format",
  "d3-geo",
  "d3-hierarchy",
  "d3-interpolate",
  "d3-path",
  "d3-polygon",
  "d3-quadtree",
  "d3-random",
  "d3-scale",
  "d3-scale-chromatic",
  "d3-selection",
  "d3-shape",
  "d3-time",
  "d3-time-format",
  "d3-timer",
  "d3-transition",
  "d3-zoom"
]);

function resolveInlineWidgetModule(specifier: string) {
  return specifier === "d3" || specifier.startsWith("d3-") ? d3Require.resolve(specifier) : require.resolve(specifier);
}

function diagnostics(messages: Message[]) {
  return messages.map((message) => {
    const location = message.location ? `${message.location.line}:${message.location.column + 1} ` : "";
    return `${location}${message.text}`;
  });
}

function runtimeBridge(token: string, capability: InlineWidgetCapability) {
  return `<script>
(() => {
  const token = ${JSON.stringify(token)};
  const send = (type, value) => parent.postMessage({ source: "cake-inline-widget", token, type, value }, "*");
  addEventListener("error", (event) => send("error", event.error?.stack || event.message || "Widget runtime error"));
  addEventListener("unhandledrejection", (event) => send("error", event.reason?.stack || String(event.reason || "Unhandled widget rejection")));
  ${capability === "request" ? `globalThis.cakeRequest = Object.freeze({ submit: (value) => send("submit", value), cancel: () => send("cancel", true) });` : ""}
  addEventListener("DOMContentLoaded", () => {
    const reportSize = () => send("height", Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0));
    new ResizeObserver(reportSize).observe(document.documentElement);
    reportSize();
    send("ready", true);
  });
})();
</script>`;
}

function documentShell(token: string, body: string, capability: InlineWidgetCapability) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:light dark;font:14px/1.5 system-ui,sans-serif;background:transparent}body{min-width:0;margin:0;padding:16px;overflow:auto;color:CanvasText;background:Canvas}*,*::before,*::after{box-sizing:border-box}body>*{max-width:100%}#cake-widget-root{min-width:0;max-width:100%}:where(h1,h2,h3,h4,h5,h6,p,span,a,button,label,legend,th,td){overflow-wrap:anywhere}img,svg,video,canvas{max-width:100%;height:auto}button,input,select,textarea{max-width:100%;font:inherit}</style>${runtimeBridge(token, capability)}</head><body>${body}</body></html>`;
}

function widgetModulePlugin(source: string): Plugin {
  return {
    name: "cake-inline-widget",
    setup(builder) {
      builder.onResolve({ filter: /^cake:inline-widget$/ }, () => ({ path: "widget.tsx", namespace: "cake-widget" }));
      builder.onLoad({ filter: /.*/, namespace: "cake-widget" }, () => ({ contents: source, loader: "tsx", resolveDir: process.cwd() }));
      builder.onResolve({ filter: /.*/, namespace: "cake-widget" }, (args) => {
        if (inlineWidgetSharedModules.has(args.path)) return { path: resolveInlineWidgetModule(args.path) };
        return { errors: [{ text: `Inline React widgets may import React or approved D3 modules only; received ${JSON.stringify(args.path)}` }] };
      });
    }
  };
}

export async function compileInlineWidget(language: InlineWidgetLanguage, source: string, capability: InlineWidgetCapability = "display"): Promise<CompiledInlineWidgetDocument> {
  if (new TextEncoder().encode(source).byteLength > maximumSourceBytes) throw new Error("Inline widget source exceeds the 1 MB limit");
  const token = crypto.randomUUID();
  if (language === "html") return { token, document: documentShell(token, source, capability) };

  const reactPath = require.resolve("react");
  const reactDomPath = require.resolve("react-dom/client");
  const entry = `
import React from ${JSON.stringify(reactPath)};
import { createRoot } from ${JSON.stringify(reactDomPath)};
import Widget from "cake:inline-widget";
const host = document.getElementById("cake-widget-root");
if (typeof Widget !== "function") throw new Error("A cake-react widget must default-export one React component");
createRoot(host).render(React.createElement(Widget, ${capability === "request" ? "globalThis.cakeRequest" : "undefined"}));
`;
  const result = await build({
    stdin: { contents: entry, loader: "tsx", resolveDir: process.cwd(), sourcefile: "cake-widget-entry.tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    plugins: [widgetModulePlugin(source)],
    logLevel: "silent"
  }).catch((error: unknown) => {
    const messages = isBuildFailure(error)
      ? diagnostics(error.errors)
      : [error instanceof Error ? error.message : String(error)];
    throw new Error(messages.join("\n"));
  });
  const javascript = result.outputFiles[0]?.text;
  if (!javascript) throw new Error("Cake did not produce an inline React widget bundle");
  return { token, document: documentShell(token, `<div id="cake-widget-root"></div><script>${javascript.replaceAll("</script", "<\\/script")}</script>`, capability) };
}

interface InlineWidgetBuildFailure { errors: Message[] }

function isBuildFailure(error: unknown): error is InlineWidgetBuildFailure {
  return typeof error === "object" && error !== null && "errors" in error && Array.isArray(error.errors);
}

export function extractRepairedWidget(text: string, language: InlineWidgetLanguage) {
  const fence = language === "html" ? "cake-html" : "cake-react";
  const match = new RegExp("(?:^|\\n)```" + fence + "[^\\S\\r\\n]*\\r?\\n([\\s\\S]*?)\\r?\\n```(?:\\n|$)").exec(text);
  const source = (match?.[1] ?? text).trim();
  if (!source) throw new Error("The repair agent returned an empty widget");
  return source;
}
