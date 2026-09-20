import { WebContentsView, type BrowserWindow } from "electron";
import { Option, Schema } from "effect";
import { jsonValueSchema, type JsonObject, type JsonValue } from "../../ipc/json-contract";
import type { BrowserAction, BrowserBounds, BrowserState } from "./Browser";

const DEFAULT_URL = "http://localhost:3000";
const inspectedElementSchema = Schema.Struct({
  tagName: Schema.String,
  selector: Schema.String,
  outerHTML: Schema.String,
  text: Schema.String,
});

interface BrowserEntry {
  readonly sessionId: string;
  ownerId: number;
  window: BrowserWindow;
  readonly view: WebContentsView;
  readonly cdpEvents: Array<{ readonly method: string; readonly params: JsonValue }>;
  inspecting: boolean;
  inspectionRevision: number;
}

type BrowserRuntimeEvent =
  | ({ readonly type: "browser-state-changed" } & BrowserState)
  | {
      readonly type: "browser-element-selected";
      readonly sessionId: string;
      readonly url: string;
      readonly tagName: string;
      readonly selector: string;
      readonly outerHTML: string;
      readonly text: string;
    };

export interface BrowserRuntimeOptions {
  readonly emit: (ownerId: number, event: BrowserRuntimeEvent) => void;
}

/** Imperative Electron adapter kept behind the scoped Browser Service. */
export class BrowserRuntime {
  private readonly entries = new Map<string, BrowserEntry>();
  private readonly activeByOwner = new Map<number, string>();
  private readonly boundsByOwner = new Map<number, BrowserBounds>();

  constructor(private readonly options: BrowserRuntimeOptions) {}

  async open(
    ownerId: number,
    window: BrowserWindow,
    sessionId: string,
    url?: string,
    signal?: AbortSignal,
  ): Promise<BrowserState> {
    signal?.throwIfAborted();
    let entry = this.entries.get(sessionId);
    if (!entry) {
      const view = new WebContentsView({
        webPreferences: {
          partition: "persist:cake-browser",
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      entry = {
        sessionId,
        ownerId,
        window,
        view,
        cdpEvents: [],
        inspecting: false,
        inspectionRevision: 0,
      };
      this.entries.set(sessionId, entry);
      this.installListeners(entry);
      view.webContents.setWindowOpenHandler(({ url: target }) => {
        if (/^https?:/i.test(target)) void view.webContents.loadURL(target);
        return { action: "deny" };
      });
      window.contentView.addChildView(view);
      view.setVisible(false);
      try {
        await view.webContents.loadURL(normalizeUrl(url ?? DEFAULT_URL));
      } catch {
        // Chromium still renders its navigation error page. Keep Browser Mode usable so
        // the user can enter another URL even when the conventional local port is closed.
      }
      signal?.throwIfAborted();
    } else if (entry.ownerId !== ownerId) {
      detach(entry.window, entry.view);
      if (this.activeByOwner.get(entry.ownerId) === sessionId)
        this.activeByOwner.delete(entry.ownerId);
      entry.ownerId = ownerId;
      entry.window = window;
    } else if (url && normalizeUrl(url) !== entry.view.webContents.getURL()) {
      await entry.view.webContents.loadURL(normalizeUrl(url));
      signal?.throwIfAborted();
    }

    const previousSessionId = this.activeByOwner.get(ownerId);
    if (previousSessionId && previousSessionId !== sessionId)
      this.entries.get(previousSessionId)?.view.setVisible(false);
    this.activeByOwner.set(ownerId, sessionId);
    if (!window.contentView.children.includes(entry.view))
      window.contentView.addChildView(entry.view);
    this.applyBounds(entry);
    const state = this.snapshot(entry);
    this.emitState(entry);
    return state;
  }

  state(sessionId: string): BrowserState {
    return this.snapshot(this.require(sessionId));
  }

  updateBounds(ownerId: number, bounds: BrowserBounds): BrowserState {
    const previous = this.boundsByOwner.get(ownerId);
    this.boundsByOwner.set(
      ownerId,
      hasGeometry(bounds) || !previous ? bounds : { ...previous, visible: bounds.visible },
    );
    const entry = this.require(bounds.sessionId);
    if (entry.ownerId !== ownerId) throw new Error("Browser view belongs to another window");
    this.activeByOwner.set(ownerId, bounds.sessionId);
    this.applyBounds(entry);
    return this.snapshot(entry);
  }

  async navigate(sessionId: string, url: string, signal?: AbortSignal): Promise<BrowserState> {
    const entry = this.require(sessionId);
    await entry.view.webContents.loadURL(normalizeUrl(url));
    signal?.throwIfAborted();
    return this.snapshot(entry);
  }

  action(sessionId: string, action: BrowserAction): BrowserState {
    const entry = this.require(sessionId);
    const contents = entry.view.webContents;
    if (action === "back" && contents.canGoBack()) contents.goBack();
    else if (action === "forward" && contents.canGoForward()) contents.goForward();
    else if (action === "reload") contents.reload();
    else if (action === "stop") contents.stop();
    return this.snapshot(entry);
  }

  async inspect(sessionId: string): Promise<BrowserState> {
    const entry = this.require(sessionId);
    const revision = ++entry.inspectionRevision;
    entry.inspecting = true;
    this.emitState(entry);
    void this.completeInspection(entry, revision);
    return this.snapshot(entry);
  }

  async sendCdp(sessionId: string, method: string, params: JsonObject): Promise<JsonValue> {
    const entry = this.require(sessionId);
    this.attachDebugger(entry);
    const value = await entry.view.webContents.debugger.sendCommand(method, params);
    return Schema.decodeUnknownSync(jsonValueSchema)(value ?? null);
  }

  takeCdpEvents(sessionId: string, methods: ReadonlyArray<string>, limit: number, clear: boolean) {
    const entry = this.require(sessionId);
    const accepted = methods.length ? new Set(methods) : undefined;
    const selected = entry.cdpEvents
      .filter((event) => !accepted || accepted.has(event.method))
      .slice(-limit);
    if (clear) {
      if (!accepted) entry.cdpEvents.splice(0);
      else
        for (let index = entry.cdpEvents.length - 1; index >= 0; index -= 1)
          if (accepted.has(entry.cdpEvents[index]!.method)) entry.cdpEvents.splice(index, 1);
    }
    return selected;
  }

  closeForWindow(ownerId: number) {
    this.activeByOwner.delete(ownerId);
    this.boundsByOwner.delete(ownerId);
    for (const [sessionId, entry] of this.entries) {
      if (entry.ownerId !== ownerId) continue;
      this.entries.delete(sessionId);
      detach(entry.window, entry.view);
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    }
  }

  dispose() {
    for (const ownerId of new Set([...this.entries.values()].map((entry) => entry.ownerId)))
      this.closeForWindow(ownerId);
  }

  private installListeners(entry: BrowserEntry) {
    const contents = entry.view.webContents;
    const emit = () => this.emitState(entry);
    contents.on("did-start-loading", emit);
    contents.on("did-stop-loading", emit);
    contents.on("did-navigate", emit);
    contents.on("did-navigate-in-page", emit);
    contents.on("page-title-updated", emit);
    contents.on("render-process-gone", emit);
    contents.debugger.on("message", (_event, method, params) => {
      const value = Option.getOrElse(
        Schema.decodeUnknownOption(jsonValueSchema)(params),
        () => null,
      );
      entry.cdpEvents.push({ method, params: value });
      if (entry.cdpEvents.length > 500) entry.cdpEvents.splice(0, entry.cdpEvents.length - 500);
    });
  }

  private async completeInspection(entry: BrowserEntry, revision: number) {
    try {
      const result = await entry.view.webContents.executeJavaScript(inspectorScript);
      if (revision !== entry.inspectionRevision) return;
      const selected = Schema.decodeUnknownOption(inspectedElementSchema)(result);
      entry.inspecting = false;
      if (Option.isSome(selected)) {
        this.options.emit(entry.ownerId, {
          type: "browser-element-selected",
          sessionId: entry.sessionId,
          url: entry.view.webContents.getURL(),
          tagName: selected.value.tagName.slice(0, 128),
          selector: selected.value.selector.slice(0, 4_096),
          outerHTML: selected.value.outerHTML.slice(0, 48_000),
          text: selected.value.text.slice(0, 8_000),
        });
      }
      this.emitState(entry);
    } catch {
      if (revision !== entry.inspectionRevision) return;
      entry.inspecting = false;
      this.emitState(entry);
    }
  }

  private attachDebugger(entry: BrowserEntry) {
    if (!entry.view.webContents.debugger.isAttached()) entry.view.webContents.debugger.attach();
  }

  private require(sessionId: string) {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.view.webContents.isDestroyed()) throw new Error("Browser mode is not open");
    return entry;
  }

  private snapshot(entry: BrowserEntry): BrowserState {
    const contents = entry.view.webContents;
    return {
      sessionId: entry.sessionId,
      url: contents.getURL() || DEFAULT_URL,
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.canGoBack(),
      canGoForward: contents.canGoForward(),
      inspecting: entry.inspecting,
    };
  }

  private emitState(entry: BrowserEntry) {
    this.options.emit(entry.ownerId, { type: "browser-state-changed", ...this.snapshot(entry) });
  }

  private applyBounds(entry: BrowserEntry) {
    const bounds = this.boundsByOwner.get(entry.ownerId);
    const active = this.activeByOwner.get(entry.ownerId) === entry.sessionId;
    entry.view.setVisible(Boolean(active && bounds?.visible && hasGeometry(bounds)));
    if (!bounds || !hasGeometry(bounds)) return;
    entry.view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
  }
}

function hasGeometry(bounds: BrowserBounds) {
  return bounds.width > 0 && bounds.height > 0;
}

function normalizeUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_URL;
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function detach(window: BrowserWindow, view: WebContentsView) {
  if (!window.isDestroyed() && window.contentView.children.includes(view))
    window.contentView.removeChildView(view);
}

const inspectorScript = `(() => {
  const cancelKey = "__cakeCancelElementInspection";
  const previousCancel = globalThis[cancelKey];
  if (typeof previousCancel === "function") previousCancel();
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.setAttribute("data-cake-element-inspector", "");
    Object.assign(overlay.style, {
      position: "fixed",
      zIndex: "2147483647",
      pointerEvents: "none",
      boxSizing: "border-box",
      background: "rgba(111, 168, 220, 0.25)",
      border: "2px solid rgba(111, 168, 220, 0.95)",
      borderRadius: "2px",
      display: "none",
    });
    document.documentElement.append(overlay);

    let target;
    let settled = false;
    const cleanup = () => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("click", select, true);
      document.removeEventListener("keydown", keydown, true);
      window.removeEventListener("scroll", update, true);
      overlay.remove();
      if (globalThis[cancelKey] === cancel) delete globalThis[cancelKey];
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const cancel = () => finish(null);
    const update = () => {
      if (!target || !target.isConnected) {
        overlay.style.display = "none";
        return;
      }
      const rect = target.getBoundingClientRect();
      Object.assign(overlay.style, {
        display: rect.width > 0 && rect.height > 0 ? "block" : "none",
        left: rect.left + "px",
        top: rect.top + "px",
        width: rect.width + "px",
        height: rect.height + "px",
      });
    };
    const eventTarget = (event) => {
      const candidate = event.composedPath().find(
        (value) => value instanceof Element && value !== overlay,
      );
      return candidate instanceof Element ? candidate : undefined;
    };
    const move = (event) => {
      target = eventTarget(event);
      update();
    };
    const select = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      target = eventTarget(event) ?? target;
      if (!target) return;
      const tagName = target.tagName.toLowerCase();
      const escapedId = target.id ? CSS.escape(target.id) : "";
      const classes = [...target.classList].map((value) => CSS.escape(value));
      const selector = escapedId
        ? "#" + escapedId
        : classes.length
          ? tagName + "." + classes.join(".")
          : tagName;
      finish({
        tagName,
        selector,
        outerHTML: target.outerHTML || "",
        text: (target.textContent || "").replace(/\\s+/g, " ").trim(),
      });
    };
    const keydown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
    };

    globalThis[cancelKey] = cancel;
    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", select, true);
    document.addEventListener("keydown", keydown, true);
    window.addEventListener("scroll", update, true);
  });
})()`;
