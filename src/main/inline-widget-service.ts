import { createRequire } from "node:module";
import { build, type Message, type Plugin } from "esbuild";

export type InlineWidgetLanguage = "html" | "react";
export type InlineWidgetCapability = "display" | "request";

export interface CompiledInlineWidgetDocument {
  document: string;
  token: string;
}

const require = createRequire(import.meta.url);
const maximumSourceBytes = 1_048_576;

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
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:light dark;font:14px/1.5 system-ui,sans-serif;background:transparent}body{margin:0;padding:16px;overflow:auto;color:CanvasText;background:Canvas}*,*::before,*::after{box-sizing:border-box}img,svg,video,canvas{max-width:100%;height:auto}button,input,select,textarea{font:inherit}</style>${runtimeBridge(token, capability)}</head><body>${body}</body></html>`;
}

function widgetModulePlugin(source: string): Plugin {
  const allowed = new Set(["react", "react/jsx-runtime", "react/jsx-dev-runtime"]);
  return {
    name: "cake-inline-widget",
    setup(builder) {
      builder.onResolve({ filter: /^cake:inline-widget$/ }, () => ({ path: "widget.tsx", namespace: "cake-widget" }));
      builder.onLoad({ filter: /.*/, namespace: "cake-widget" }, () => ({ contents: source, loader: "tsx", resolveDir: process.cwd() }));
      builder.onResolve({ filter: /.*/, namespace: "cake-widget" }, (args) => {
        if (allowed.has(args.path)) return { path: require.resolve(args.path) };
        return { errors: [{ text: `Inline React widgets may import React only; received ${JSON.stringify(args.path)}` }] };
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
    const messages = typeof error === "object" && error !== null && "errors" in error && Array.isArray(error.errors)
      ? diagnostics(error.errors as Message[])
      : [error instanceof Error ? error.message : String(error)];
    throw new Error(messages.join("\n"));
  });
  const javascript = result.outputFiles[0]?.text;
  if (!javascript) throw new Error("Cake did not produce an inline React widget bundle");
  return { token, document: documentShell(token, `<div id="cake-widget-root"></div><script>${javascript.replaceAll("</script", "<\\/script")}</script>`, capability) };
}

export function extractRepairedWidget(text: string, language: InlineWidgetLanguage) {
  const fence = language === "html" ? "cake-html" : "cake-react";
  const match = new RegExp("(?:^|\\n)```" + fence + "[^\\S\\r\\n]*\\r?\\n([\\s\\S]*?)\\r?\\n```(?:\\n|$)").exec(text);
  const source = (match?.[1] ?? text).trim();
  if (!source) throw new Error("The repair agent returned an empty widget");
  return source;
}
