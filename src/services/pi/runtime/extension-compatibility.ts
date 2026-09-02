import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import type { ExtensionUiEvent } from "../../../ipc/session-contract";
import type { RuntimeUiRequest } from "./cake-runtime";

export function createCakeExtensionUiContext(options: {
  request(request: RuntimeUiRequest): Promise<string | undefined>;
  emit(event: ExtensionUiEvent): void;
  state: {
    statuses: Array<{ key: string; text: string }>;
    notifications: Array<{ id: string; message: string; tone: "info" | "warning" | "error" }>;
    title?: string;
    editorText?: { text: string; mode: "replace" | "insert" };
    editorTextRevision: number;
  };
  addDiagnostic(method: string, message: string): void;
}): ExtensionUIContext {
  let editorText = "";
  const degraded = (method: string, detail: string) =>
    options.addDiagnostic(method, `${method} is unavailable in Cake: ${detail}`);
  const dialog = (request: RuntimeUiRequest) => options.request(request);
  return {
    async select(title, values, opts) {
      const projected = values
        .slice(0, 100)
        .map((value) => ({ id: boundedProjectionKey(value), label: value, value }));
      const selected = await dialog({
        kind: "select",
        title,
        message: title,
        options: projected.map(({ id, label }) => ({ id, label })),
        signal: opts?.signal,
        timeout: opts?.timeout,
      });
      return projected.find((option) => option.id === selected)?.value;
    },
    async confirm(title, message, opts) {
      return (
        (await dialog({
          kind: "confirm",
          title,
          message,
          signal: opts?.signal,
          timeout: opts?.timeout,
        })) === "true"
      );
    },
    input: (title, placeholder, opts) =>
      dialog({
        kind: "text",
        title,
        message: title,
        placeholder,
        signal: opts?.signal,
        timeout: opts?.timeout,
      }),
    notify(message, tone = "info") {
      const event = { kind: "notify" as const, id: crypto.randomUUID(), message, tone };
      options.state.notifications.push(event);
      if (options.state.notifications.length > 8)
        options.state.notifications.splice(0, options.state.notifications.length - 8);
      options.emit(event);
    },
    onTerminalInput() {
      degraded("onTerminalInput", "raw terminal input has no desktop equivalent");
      return () => undefined;
    },
    setStatus(key, text) {
      key = boundedProjectionKey(key);
      const index = options.state.statuses.findIndex((status) => status.key === key);
      if (text === undefined) {
        if (index >= 0) options.state.statuses.splice(index, 1);
      } else if (index >= 0) options.state.statuses.splice(index, 1, { key, text });
      else options.state.statuses.push({ key, text });
      options.emit({ kind: "status", key, text });
    },
    setWorkingMessage(message) {
      degraded(
        "setWorkingMessage",
        message ? "Cake owns its streaming indicator" : "Cake owns its streaming indicator",
      );
    },
    setWorkingVisible() {
      degraded("setWorkingVisible", "Cake owns streaming visibility");
    },
    setWorkingIndicator() {
      degraded("setWorkingIndicator", "terminal animation frames are not web UI");
    },
    setHiddenThinkingLabel() {
      degraded("setHiddenThinkingLabel", "Cake uses its accessible reasoning label");
    },
    setWidget() {
      degraded(
        "setWidget",
        "terminal widgets cannot run in the Cake renderer; use a Cake artifact",
      );
    },
    setFooter() {
      degraded("setFooter", "terminal footer factories cannot run in the renderer");
    },
    setHeader() {
      degraded("setHeader", "terminal header factories cannot run in the renderer");
    },
    setTitle(title) {
      options.state.title = title;
      options.emit({ kind: "title", title });
    },
    async custom() {
      degraded("custom", "arbitrary TUI components require a Cake artifact or widget fallback");
      throw new Error("Cake cannot host an arbitrary terminal UI component");
    },
    pasteToEditor(text) {
      editorText += text;
      options.state.editorText = { text: editorText, mode: "replace" };
      options.state.editorTextRevision += 1;
      options.emit({ kind: "editor-text", text, mode: "insert" });
    },
    setEditorText(text) {
      editorText = text;
      options.state.editorText = { text, mode: "replace" };
      options.state.editorTextRevision += 1;
      options.emit({ kind: "editor-text", text, mode: "replace" });
    },
    getEditorText: () => editorText,
    editor: (title, prefill) =>
      dialog({
        kind: "editor",
        title,
        message: title,
        initialValue: prefill ?? "",
        multiline: true,
      }),
    addAutocompleteProvider() {
      degraded(
        "addAutocompleteProvider",
        "terminal autocomplete providers cannot attach to the web composer",
      );
    },
    setEditorComponent() {
      degraded("setEditorComponent", "terminal editor components cannot replace the web composer");
    },
    getEditorComponent: () => undefined,
    get theme() {
      degraded("theme", "Pi TUI themes are not Cake renderer themes");
      return unsupported("theme");
    },
    getAllThemes: () => [],
    getTheme(name) {
      degraded("getTheme", `Pi TUI theme ${name} is unavailable`);
      return undefined;
    },
    setTheme() {
      degraded("setTheme", "extensions cannot replace Cake's renderer theme");
      return { success: false, error: "Pi TUI themes are unavailable in Cake" };
    },
    getToolsExpanded: () => false,
    setToolsExpanded() {
      degraded("setToolsExpanded", "tool expansion is controlled by the Cake transcript");
    },
  };
}

function unsupported(name: string): never {
  throw new Error(`Pi extension UI method ${name} is not supported by the Cake adapter`);
}

function boundedProjectionKey(value: string, maximum = 256) {
  if (value.length <= maximum) return value;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${value.slice(0, maximum - digest.length - 1)}:${digest}`;
}
