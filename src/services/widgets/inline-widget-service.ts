import { sessionPluginThemeTokens } from "../../utils/session-plugin-theme";
import { dirname } from "node:path";
import { TextEncoder } from "node:util";
import { fileURLToPath } from "node:url";
import { build, type Message, type Plugin } from "esbuild";

export type InlineWidgetLanguage = "html" | "react";
export type InlineWidgetCapability = "display" | "request" | "session-plugin";

export interface CompiledInlineWidgetDocument {
  document: string;
  token: string;
}

const cakeModuleResolveDirectory = dirname(fileURLToPath(import.meta.url));
const d3ModulePath = fileURLToPath(import.meta.resolve("d3"));
const d3ResolveDirectory = dirname(d3ModulePath);
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
  "d3-zoom",
]);

function resolveInlineWidgetModule(specifier: string) {
  return fileURLToPath(import.meta.resolve(specifier));
}

const approvedImportsDescription =
  "React, approved D3 modules, or @cake/plugin-sdk in Session Plugins";

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
    if (event.source !== parent || !message || message.source !== "cake-session-plugin-host" || message.token !== token) return;
    if (message.type === "context") {
      const theme = message.value.theme;
      if (theme && (theme.colorScheme === "light" || theme.colorScheme === "dark")) {
        document.documentElement.style.colorScheme = theme.colorScheme;
        document.documentElement.dataset.theme = theme.colorScheme;
        for (const name of ${JSON.stringify(sessionPluginThemeTokens)}) {
          const value = theme.tokens?.[name];
          if (typeof value === "string" && CSS.supports("color", value)) document.documentElement.style.setProperty("--" + name, value);
        }
      }
      publish({ hasContext: true, pluginState: message.value.pluginState, sharedState: Object.freeze(message.value.sharedState || {}) });
    }
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

function documentShell(token: string, body: string, capability: InlineWidgetCapability) {
  // Generated documents cannot inherit CSS across their opaque origin. These base
  // element rules consume the host's live tokens, never a second hardcoded palette.
  const pluginStyles =
    capability === "session-plugin"
      ? `<style>
body{padding:12px;color:var(--card-foreground);background:var(--card)}
a{color:var(--accent)}
button,input,select,textarea{border:1px solid var(--border);border-radius:6px;color:var(--foreground);background:var(--background);padding:6px 12px}
button{cursor:pointer;font-weight:600}
button:not(:disabled):hover{background:var(--muted)}
button[data-variant="primary"]{color:var(--primary-foreground);background:var(--primary);border-color:var(--primary)}
button[data-variant="primary"]:not(:disabled):hover{background:color-mix(in srgb,var(--primary) 88%,transparent)}
:where(button,input,select,textarea,a):focus-visible{outline:2px solid var(--ring);outline-offset:2px}
:where(button,input,select,textarea):disabled{opacity:.45;cursor:default}
</style>`
      : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:light dark;font:14px/1.5 system-ui,sans-serif;background:transparent}body{min-width:0;margin:0;padding:16px;overflow:auto;color:CanvasText;background:Canvas}*,*::before,*::after{box-sizing:border-box}body>*{max-width:100%}#cake-widget-root{min-width:0;max-width:100%}:where(h1,h2,h3,h4,h5,h6,p,span,a,button,label,legend,th,td){overflow-wrap:anywhere}img,svg,video,canvas{max-width:100%;height:auto}button,input,select,textarea{max-width:100%;font:inherit}</style>${pluginStyles}${runtimeBridge(token, capability)}</head><body>${body}</body></html>`;
}

function widgetModulePlugin(source: string): Plugin {
  return {
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
        // electron-vite scans multiline template literals as host imports during
        // production builds, so keep generated-module imports in separate strings.
        contents: [
          'import { useCallback, useSyncExternalStore } from "react";',
          "const bridge = globalThis.__cakePluginBridge;",
          'if (!bridge) throw new Error("@cake/plugin-sdk is only available in Session Plugins");',
          "export function useCake() { return bridge.cake; }",
          "function useSnapshot() { return useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot); }",
          "export function usePluginState(initialState = null) {",
          "  const snapshot = useSnapshot();",
          "  const value = snapshot.hasContext ? snapshot.pluginState : initialState;",
          '  const setValue = useCallback((next) => { const current = bridge.getSnapshot(); return bridge.cake.call("plugins.set-state", { state: typeof next === "function" ? next(current.hasContext ? current.pluginState : initialState) : next }); }, [initialState]);',
          "  return [value, setValue];",
          "}",
          "export function useSharedState(key, initialState = null) {",
          "  const snapshot = useSnapshot();",
          "  const value = Object.prototype.hasOwnProperty.call(snapshot.sharedState, key) ? snapshot.sharedState[key] : initialState;",
          '  const setValue = useCallback((next) => { const current = bridge.getSnapshot(); const previous = Object.prototype.hasOwnProperty.call(current.sharedState, key) ? current.sharedState[key] : initialState; return bridge.cake.call("plugins.set-shared-state", { key, value: typeof next === "function" ? next(previous) : next }); }, [initialState, key]);',
          "  return [value, setValue];",
          "}",
        ].join("\n"),
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
                text: `Inline React widgets may import ${approvedImportsDescription} only; received ${JSON.stringify(args.path)}`,
              },
            ],
          };
        }
        if (args.path === "d3") return { path: d3ModulePath };
        if (args.path.startsWith("d3-")) {
          return builder.resolve(args.path, {
            kind: args.kind,
            resolveDir: d3ResolveDirectory,
            pluginData: { cakeApprovedLibrary: true },
          });
        }
        return { path: resolveInlineWidgetModule(args.path) };
      });
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

  const reactPath = resolveInlineWidgetModule("react");
  const reactDomPath = resolveInlineWidgetModule("react-dom/client");
  // See the virtual plugin SDK above: avoid host import rewriting inside this source.
  const entry = [
    `import React from ${JSON.stringify(reactPath)};`,
    `import { createRoot } from ${JSON.stringify(reactDomPath)};`,
    'import Widget from "cake:inline-widget";',
    'const host = document.getElementById("cake-widget-root");',
    'if (typeof Widget !== "function") throw new Error("A cake-react widget must default-export one React component");',
    `createRoot(host).render(React.createElement(Widget, ${capability === "request" ? "globalThis.cakeRequest" : "undefined"}));`,
  ].join("\n");
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
    plugins: [widgetModules],
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
