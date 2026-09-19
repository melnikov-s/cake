import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Message, type Plugin } from "esbuild";

export type InlineWidgetLanguage = "html" | "react";
export type InlineWidgetCapability = "display" | "request" | "session-plugin";

export interface CompiledInlineWidgetDocument {
  document: string;
  token: string;
}

const require = createRequire(import.meta.url);
const cakeModuleResolveDirectory = dirname(fileURLToPath(import.meta.url));
const d3Require = createRequire(require.resolve("d3"));
const maximumSourceBytes = 1_048_576;
const reactFlowStyles = readFileSync(require.resolve("@xyflow/react/dist/style.css"), "utf8");
const reactModulePaths = new Map([
  ["react", require.resolve("react")],
  ["react/jsx-runtime", require.resolve("react/jsx-runtime")],
  ["react/jsx-dev-runtime", require.resolve("react/jsx-dev-runtime")],
  ["react-dom", require.resolve("react-dom")],
  ["react-dom/client", require.resolve("react-dom/client")],
]);

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
  "d3-zoom",
  "@xyflow/react",
  "elkjs/lib/elk.bundled.js",
]);

function resolveInlineWidgetModule(specifier: string) {
  return specifier === "d3" || specifier.startsWith("d3-")
    ? d3Require.resolve(specifier)
    : require.resolve(specifier);
}

const approvedImportsDescription =
  "React, approved D3 modules, @xyflow/react, or elkjs/lib/elk.bundled.js";

function diagnostics(messages: Message[]) {
  return messages.map((message) => {
    const location = message.location
      ? `${message.location.line}:${message.location.column + 1} `
      : "";
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
  ${
    capability === "session-plugin"
      ? `
  const listeners = new Set();
  const pending = new Map();
  let requestId = 0;
  let snapshot = Object.freeze({ hasContext: false, pluginState: null, sharedState: Object.freeze({}) });
  const publish = (next) => { snapshot = Object.freeze(next); for (const listener of listeners) listener(); };
  addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.source !== "cake-session-plugin-host" || message.token !== token) return;
    if (message.type === "context") publish({ hasContext: true, pluginState: message.value.pluginState, sharedState: Object.freeze(message.value.sharedState || {}) });
    if (message.type === "call-result") {
      const operation = pending.get(message.value.id);
      if (!operation) return;
      pending.delete(message.value.id);
      if (message.value.ok) operation.resolve(message.value.result);
      else operation.reject(new Error(message.value.error || "Cake operation failed"));
    }
  });
  globalThis.__cakePluginBridge = Object.freeze({
    cake: Object.freeze({
      call(command, input = {}) {
        return new Promise((resolve, reject) => {
          const id = String(++requestId);
          pending.set(id, { resolve, reject });
          send("plugin-call", { id, command, input });
        });
      },
      session: Object.freeze({ sendMessage: (text) => globalThis.__cakePluginBridge.cake.call("session.prompt", { text }) }),
    }),
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  });`
      : ""
  }
  addEventListener("DOMContentLoaded", () => {
    const startedAt = performance.now();
    let changedAt = startedAt;
    const reportSize = () => {
      changedAt = performance.now();
      send("height", Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0));
    };
    const resize = new ResizeObserver(reportSize);
    const mutations = new MutationObserver(() => { changedAt = performance.now(); });
    resize.observe(document.documentElement);
    mutations.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    reportSize();
    Promise.resolve(document.fonts?.ready).catch(() => undefined).finally(() => {
      const settle = () => {
        const now = performance.now();
        if ((now - startedAt >= 600 && now - changedAt >= 200) || now - startedAt >= 2500) {
          mutations.disconnect();
          document.documentElement.dataset.cakeWidgetReady = "true";
          send("ready", true);
          return;
        }
        setTimeout(settle, 50);
      };
      setTimeout(settle, 50);
    });
  });
})();
</script>`;
}

function documentShell(
  token: string,
  body: string,
  capability: InlineWidgetCapability,
  libraryStyles = "",
) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:light dark;font:14px/1.5 system-ui,sans-serif;background:transparent}body{min-width:0;margin:0;padding:16px;overflow:auto;color:CanvasText;background:Canvas}*,*::before,*::after{box-sizing:border-box}body>*{max-width:100%}#cake-widget-root{min-width:0;max-width:100%}:where(h1,h2,h3,h4,h5,h6,p,span,a,button,label,legend,th,td){overflow-wrap:anywhere}img,svg,video,canvas{max-width:100%;height:auto}button,input,select,textarea{max-width:100%;font:inherit}</style>${libraryStyles}${runtimeBridge(token, capability)}</head><body>${body}</body></html>`;
}

interface WidgetModulePlugin {
  readonly plugin: Plugin;
  readonly usesReactFlow: () => boolean;
}

function widgetModulePlugin(source: string): WidgetModulePlugin {
  let usesReactFlow = false;
  return {
    usesReactFlow: () => usesReactFlow,
    plugin: {
      name: "cake-inline-widget",
      setup(builder) {
        builder.onResolve({ filter: /^cake:inline-widget$/ }, () => ({
          path: "widget.tsx",
          namespace: "cake-widget",
        }));
        builder.onResolve({ filter: /^@cake\/plugin-sdk$/ }, () => ({
          path: "plugin-sdk.ts",
          namespace: "cake-plugin-sdk",
        }));
        builder.onLoad({ filter: /.*/, namespace: "cake-plugin-sdk" }, () => ({
          loader: "ts",
          contents: `
import { useCallback, useSyncExternalStore } from "react";
const bridge = globalThis.__cakePluginBridge;
if (!bridge) throw new Error("@cake/plugin-sdk is only available in Session Plugins");
export function useCake() { return bridge.cake; }
function useSnapshot() { return useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot); }
export function usePluginState(initialState = null) {
  const snapshot = useSnapshot();
  const value = snapshot.hasContext ? snapshot.pluginState : initialState;
  const setValue = useCallback((next) => { const current = bridge.getSnapshot(); return bridge.cake.call("plugins.set-state", { state: typeof next === "function" ? next(current.hasContext ? current.pluginState : initialState) : next }); }, [initialState]);
  return [value, setValue];
}
export function useSharedState(key, initialState = null) {
  const snapshot = useSnapshot();
  const value = Object.prototype.hasOwnProperty.call(snapshot.sharedState, key) ? snapshot.sharedState[key] : initialState;
  const setValue = useCallback((next) => { const current = bridge.getSnapshot(); const previous = Object.prototype.hasOwnProperty.call(current.sharedState, key) ? current.sharedState[key] : initialState; return bridge.cake.call("plugins.set-shared-state", { key, value: typeof next === "function" ? next(previous) : next }); }, [initialState, key]);
  return [value, setValue];
}
`,
          resolveDir: cakeModuleResolveDirectory,
        }));
        builder.onLoad({ filter: /.*/, namespace: "cake-widget" }, () => ({
          contents: source,
          loader: "tsx",
          resolveDir: process.cwd(),
        }));
        builder.onResolve({ filter: /.*/, namespace: "cake-widget" }, (args) => {
          if (!inlineWidgetSharedModules.has(args.path) && args.path !== "@cake/plugin-sdk") {
            return {
              errors: [
                {
                  text: `Inline React widgets may import ${approvedImportsDescription}${args.path === "@cake/plugin-sdk" ? "" : ", or @cake/plugin-sdk in Session Plugins"} only; received ${JSON.stringify(args.path)}`,
                },
              ],
            };
          }
          if (args.path === "@xyflow/react") usesReactFlow = true;
          if (args.path === "@xyflow/react" || args.path === "elkjs/lib/elk.bundled.js") {
            return builder.resolve(args.path, {
              kind: args.kind,
              // Preserve esbuild's browser export conditions while anchoring
              // resolution to Cake's installation rather than its launch cwd.
              resolveDir: cakeModuleResolveDirectory,
              pluginData: { cakeApprovedLibrary: true },
            });
          }
          return { path: resolveInlineWidgetModule(args.path) };
        });
        // Force React Flow's peer imports onto the same React instance as the
        // widget entrypoint. Everything remains bundled into the sandbox document.
        builder.onResolve({ filter: /^(?:react|react-dom)(?:\/.*)?$/ }, (args) => {
          const path = reactModulePaths.get(args.path);
          return path ? { path } : undefined;
        });
      },
    },
  };
}

export async function compileInlineWidget(
  language: InlineWidgetLanguage,
  source: string,
  capability: InlineWidgetCapability = "display",
): Promise<CompiledInlineWidgetDocument> {
  if (new TextEncoder().encode(source).byteLength > maximumSourceBytes)
    throw new Error("Inline widget source exceeds the 1 MB limit");
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
  if (capability !== "session-plugin" && source.includes("@cake/plugin-sdk"))
    throw new Error("@cake/plugin-sdk is available only to Session Plugins");
  const widgetModules = widgetModulePlugin(source);
  const result = await build({
    stdin: {
      contents: entry,
      loader: "tsx",
      resolveDir: process.cwd(),
      sourcefile: "cake-widget-entry.tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    plugins: [widgetModules.plugin],
    logLevel: "silent",
  }).catch((error: unknown) => {
    const messages = isBuildFailure(error)
      ? diagnostics(error.errors)
      : [error instanceof Error ? error.message : String(error)];
    throw new Error(messages.join("\n"));
  });
  const javascript = result.outputFiles[0]?.text;
  if (!javascript) throw new Error("Cake did not produce an inline React widget bundle");
  return {
    token,
    document: documentShell(
      token,
      `<div id="cake-widget-root"></div><script>${javascript.replaceAll("</script", "<\\/script")}</script>`,
      capability,
      // Flow's edge SVGs overflow a zero-width absolute container. The generic media
      // max-width reset must not collapse their viewport and hide every connector.
      widgetModules.usesReactFlow()
        ? `<style data-cake-widget-library="@xyflow/react">${reactFlowStyles.replaceAll("</style", "<\\/style")}\n.react-flow__edges svg{max-width:none}</style>`
        : "",
    ),
  };
}

interface InlineWidgetBuildFailure {
  errors: Message[];
}

function isBuildFailure(error: unknown): error is InlineWidgetBuildFailure {
  return (
    typeof error === "object" && error !== null && "errors" in error && Array.isArray(error.errors)
  );
}

export function extractRepairedWidget(text: string, language: InlineWidgetLanguage) {
  const fence = language === "html" ? "cake-html" : "cake-react";
  const match = new RegExp(
    "(?:^|\\n)```" + fence + "[^\\S\\r\\n]*\\r?\\n([\\s\\S]*?)\\r?\\n```(?:\\n|$)",
  ).exec(text);
  const source = (match?.[1] ?? text).trim();
  if (!source) throw new Error("The repair agent returned an empty widget");
  return source;
}
