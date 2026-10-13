import { widgetThemeColorTokens, widgetThemeFontTokens } from "../../utils/widget-theme";
import { dirname } from "node:path";
import { TextEncoder } from "node:util";
import { fileURLToPath } from "node:url";
import { build, type Message, type Plugin } from "esbuild";
import {
  widgetPackageResolver,
  type WidgetBrowserAsset,
  type WidgetCompileOptions,
} from "./widget-package-resolver";

export type InlineWidgetLanguage = "html" | "react";
export type InlineWidgetCapability = "display" | "artifact" | "request" | "session-plugin";

export interface CompiledInlineWidgetDocument {
  document: string;
  token: string;
  assets?: ReadonlyArray<WidgetBrowserAsset>;
}

import { artifactStateWireError } from "../../contracts/widgets/artifact-state-wire";

const cakeModuleResolveDirectory = dirname(fileURLToPath(import.meta.url));

const maximumSourceBytes = 1_048_576;

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
  const applyTheme = (theme) => {
    if (!theme || (theme.colorScheme !== "light" && theme.colorScheme !== "dark")) return;
    document.documentElement.style.colorScheme = theme.colorScheme;
    document.documentElement.dataset.theme = theme.colorScheme;
    for (const name of ${JSON.stringify(widgetThemeColorTokens)}) {
      const value = theme.tokens?.[name];
      if (typeof value === "string" && CSS.supports("color", value)) document.documentElement.style.setProperty("--" + name, value);
    }
    for (const name of ${JSON.stringify(widgetThemeFontTokens)}) {
      const value = theme.tokens?.[name];
      if (typeof value === "string" && CSS.supports("font-family", value)) document.documentElement.style.setProperty("--" + name, value);
    }
  };
  const applyPresentation = (value) => {
    applyTheme(value?.theme);
    if (value?.sizing === "viewport" || value?.sizing === "content") document.documentElement.dataset.sizing = value.sizing;
    if (value?.presentation === "inline" || value?.presentation === "workspace") document.documentElement.dataset.presentation = value.presentation;
  };
  try {
    const initial = new URLSearchParams(location.hash.slice(1)).get("cake-widget");
    if (initial) applyPresentation(JSON.parse(initial));
  } catch {}
  addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== parent || message?.source !== "cake-widget-host" || message.token !== token || message.type !== "presentation") return;
    applyPresentation(message.value);
  });
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
      applyTheme(message.value.theme);
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
  ${
    capability === "artifact"
      ? `
  const stateWireError = ${artifactStateWireError.toString()};
  const stateListeners = new Set();
  const statePending = new Map();
  let stateRequestId = 0;
  let stateSnapshot = Object.freeze({ hydrated: false, version: 0, value: null, error: null });
  const publishState = (next) => { stateSnapshot = Object.freeze(next); for (const listener of stateListeners) listener(); };
  const requestState = (type, value) => new Promise((resolve, reject) => {
    const id = String(++stateRequestId);
    const timeout = setTimeout(() => {
      statePending.delete(id);
      const error = "Artifact state host is disconnected";
      publishState({ ...stateSnapshot, hydrated: false, error });
      reject(new Error(error));
    }, 15000);
    statePending.set(id, { resolve, reject, timeout });
    try { send(type, { id, ...value }); }
    catch (error) { clearTimeout(timeout); statePending.delete(id); reject(error); }
  });
  addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== parent || message?.source !== "cake-artifact-host" || message.token !== token) return;
    if (message.type === "state") {
      const state = message.value;
      if (state.version < stateSnapshot.version) return;
      publishState({ hydrated: true, version: state.version, value: state.value, error: null });
    }
    if (message.type === "state-error") publishState({ ...stateSnapshot, hydrated: false, error: message.value });
    if (message.type === "state-result") {
      const operation = statePending.get(message.value.id);
      if (!operation) return;
      clearTimeout(operation.timeout);
      statePending.delete(message.value.id);
      if (message.value.ok) {
        const state = message.value.state;
        if (state.version >= stateSnapshot.version) publishState({ hydrated: true, version: state.version, value: state.value, error: null });
        operation.resolve(state);
      } else {
        publishState({ ...stateSnapshot, error: message.value.error || "Artifact state operation failed" });
        operation.reject(new Error(message.value.error || "Artifact state operation failed"));
      }
    }
  });
  globalThis.__cakeArtifactBridge = Object.freeze({
    getSnapshot: () => stateSnapshot,
    subscribe(listener) { stateListeners.add(listener); return () => stateListeners.delete(listener); },
    read: () => requestState("artifact-state-read", {}),
    replace(value, expectedVersion = stateSnapshot.version) {
      const invalid = stateWireError(value);
      if (invalid) return Promise.reject(new Error("Invalid artifact state: " + invalid));
      if (!stateSnapshot.hydrated || stateSnapshot.error) return Promise.reject(new Error("Artifact state is not hydrated; read before saving"));
      return requestState("artifact-state-replace", { value, expectedVersion }).catch(async (error) => { await requestState("artifact-state-read", {}).catch(() => undefined); throw error; });
    },
  });
  addEventListener("DOMContentLoaded", () => { globalThis.__cakeArtifactBridge.read().catch(() => undefined); });
  `
      : ""
  }
  addEventListener("DOMContentLoaded", () => {
    const startedAt = performance.now();
    let changedAt = startedAt;
    const reportSize = () => {
      changedAt = performance.now();
      const root = document.documentElement;
      // Fractional iframe sizes can round scrollHeight one pixel above
      // clientHeight without content overflow. Treating that as overflow pins
      // the old viewport height forever after content shrinks.
      send("height", Math.ceil(root.scrollHeight > root.clientHeight + 1 ? root.scrollHeight : root.getBoundingClientRect().height));
    };
    const resize = new ResizeObserver(reportSize);
    const mutations = new MutationObserver(() => { changedAt = performance.now(); });
    resize.observe(document.documentElement);
    if (document.body) resize.observe(document.body);
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
  // System-color defaults keep standalone review captures readable without
  // inventing a second Cake palette; the host overrides these before paint.
  const defaults = widgetThemeColorTokens
    .map((name) => {
      const value =
        name.endsWith("foreground") || name === "foreground"
          ? "CanvasText"
          : ["border", "input"].includes(name)
            ? "GrayText"
            : [
                  "accent",
                  "ring",
                  "primary",
                  "success",
                  "warning",
                  "attention",
                  "destructive",
                ].includes(name)
              ? "Highlight"
              : "Canvas";
      return `--${name}:${value}`;
    })
    .join(";");
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
  const sizing =
    capability === "request" || capability === "session-plugin" ? "content" : "viewport";
  return `<!doctype html><html data-sizing="${sizing}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{${defaults};--font-sans:system-ui,sans-serif;--font-mono:monospace}html{color-scheme:light dark;font:14px/1.5 var(--font-sans,system-ui),sans-serif;background:transparent}body{min-width:0;margin:0;padding:16px;overflow:auto;color:var(--foreground,CanvasText);background:var(--background,Canvas)}html[data-presentation="inline"] body{padding:0;background:transparent}html[data-sizing="viewport"],html[data-sizing="viewport"] body,html[data-sizing="viewport"] #cake-widget-root{height:100%;min-height:0}code,pre,kbd{font-family:var(--font-mono,monospace)}*,*::before,*::after{box-sizing:border-box}body>*{max-width:100%}#cake-widget-root{min-width:0;max-width:100%}:where(h1,h2,h3,h4,h5,h6,p,span,a,button,label,legend,th,td){overflow-wrap:anywhere}img,svg,video,canvas{max-width:100%;height:auto}button,input,select,textarea{max-width:100%;font:inherit}</style>${pluginStyles}${runtimeBridge(token, capability)}</head><body>${body}</body></html>`;
}

function widgetModulePlugin(source: string): Plugin {
  return {
    name: "cake-inline-widget",
    setup(builder) {
      builder.onResolve({ filter: /^cake:inline-widget$/ }, () => ({
        path: "widget.tsx",
        namespace: "cake-widget",
      }));
      builder.onResolve({ filter: /^@cake\/artifact-sdk$/ }, () => ({
        path: "artifact-sdk.ts",
        namespace: "cake-artifact-sdk",
      }));
      builder.onLoad({ filter: /.*/, namespace: "cake-artifact-sdk" }, () => ({
        loader: "ts",
        contents: [
          'import { useCallback, useSyncExternalStore } from "react";',
          "const bridge = globalThis.__cakeArtifactBridge;",
          'if (!bridge) throw new Error("@cake/artifact-sdk is only available in artifact widgets");',
          "export function useArtifact() { const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot); const replace = useCallback((value, expectedVersion = snapshot.version) => bridge.replace(value, expectedVersion), [snapshot.version]); return { ...snapshot, read: bridge.read, replace }; }",
          "export function useArtifactState(initialValue = null) {",
          "  const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot);",
          "  const save = useCallback((value) => bridge.replace(value, snapshot.version), [snapshot.version]);",
          "  return { value: snapshot.version === 0 ? initialValue : snapshot.value, hydrated: snapshot.hydrated, version: snapshot.version, error: snapshot.error, save, reload: bridge.read };",
          "}",
        ].join("\n"),
        resolveDir: cakeModuleResolveDirectory,
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
    },
  };
}

export async function compileInlineWidget(
  language: InlineWidgetLanguage,
  source: string,
  capability: InlineWidgetCapability = "display",
  options: WidgetCompileOptions = {},
): Promise<CompiledInlineWidgetDocument> {
  if (new TextEncoder().encode(source).byteLength > maximumSourceBytes)
    throw new Error("Inline widget source exceeds the 1 MB limit");
  const token = crypto.randomUUID();
  if (language === "html") return { token, document: documentShell(token, source, capability) };

  const packages = await widgetPackageResolver(options, token);
  // See the virtual plugin SDK above: avoid host import rewriting inside this source.
  const entry = [
    'import React from "react";',
    'import { createRoot } from "react-dom/client";',
    'import Widget from "cake:inline-widget";',
    'const host = document.getElementById("cake-widget-root");',
    'if (typeof Widget !== "function") throw new Error("A cake-react widget must default-export one React component");',
    `createRoot(host).render(React.createElement(Widget, ${capability === "request" ? "globalThis.cakeRequest" : "undefined"}));`,
  ].join("\n");
  if (capability !== "session-plugin" && source.includes("@cake/plugin-sdk"))
    throw new Error("@cake/plugin-sdk is available only to Session Plugins");
  if (capability !== "artifact" && source.includes("@cake/artifact-sdk"))
    throw new Error("@cake/artifact-sdk is available only to artifact widgets");
  const widgetModules = widgetModulePlugin(source);
  const result = await build({
    stdin: {
      contents: entry,
      loader: "tsx",
      resolveDir: process.cwd(),
      sourcefile: "cake-widget-entry.tsx",
    },
    bundle: true,
    minify: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    plugins: [packages.plugin, widgetModules],
    outfile: "widget.js",
    conditions: ["browser", "production"],
    define: { "process.env.NODE_ENV": '"production"' },
    loader: {
      ".png": "dataurl",
      ".jpg": "dataurl",
      ".jpeg": "dataurl",
      ".gif": "dataurl",
      ".svg": "dataurl",
      ".webp": "dataurl",
      ".woff": "dataurl",
      ".woff2": "dataurl",
      ".ttf": "dataurl",
      ".otf": "dataurl",
    },
    logLevel: "silent",
  }).catch((error: unknown) => {
    const messages = isBuildFailure(error)
      ? diagnostics(error.errors)
      : [error instanceof Error ? error.message : String(error)];
    throw new Error(messages.join("\n"));
  });
  const javascript = result.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
  const css = result.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
  if (!javascript) throw new Error("Cake did not produce an inline React widget bundle");
  return {
    token,
    assets: packages.assets,
    document: documentShell(
      token,
      `<style>${css.replaceAll("</style", "<\\/style")}</style><div id="cake-widget-root"></div><script>${javascript.replaceAll("</script", "<\\/script")}</script>`,
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
