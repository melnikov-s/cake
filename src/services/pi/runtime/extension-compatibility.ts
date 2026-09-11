import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import type { ExtensionUiEvent, ExtensionUiIntent } from "../../../ipc/session-contract";
import type { RuntimeUiRequest } from "./runtime-ui-request";

export function createCakeExtensionUiContext(options: {
  request(request: RuntimeUiRequest): Promise<string | undefined>;
  emitState(event: ExtensionUiEvent): void;
  emitIntent(intent: ExtensionUiIntent): void;
  state: { statuses: Array<{ key: string; text: string }>; title?: string };
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
      options.emitIntent({ kind: "notify", id: crypto.randomUUID(), message, tone });
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
      options.emitState({ kind: "status", key, text });
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
      options.emitState({ kind: "title", title });
    },
    async custom() {
      degraded("custom", "arbitrary TUI components require a Cake artifact or widget fallback");
      throw new Error("Cake cannot host an arbitrary terminal UI component");
    },
    pasteToEditor(text) {
      editorText += text;
      options.emitIntent({ kind: "editor-text", text, mode: "insert" });
    },
    setEditorText(text) {
      editorText = text;
      options.emitIntent({ kind: "editor-text", text, mode: "replace" });
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
    theme: createUnavailableTheme(() =>
      degraded(
        "theme",
        "Pi TUI themes are not Cake renderer themes; styling renders as plain text",
      ),
    ),
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

const THEME_TEXT_STYLES = new Set([
  "fg",
  "bg",
  "bold",
  "italic",
  "underline",
  "inverse",
  "strikethrough",
]);
const THEME_ANSI_GETTERS = new Set(["getFgAnsi", "getBgAnsi"]);

/**
 * A `Theme` for a host with no terminal. Reading it costs nothing: Pi's
 * extension runner spreads the UI context (`{ ...ui }`) when it binds, so the
 * member must not throw on access. Using it is where degradation is reported,
 * once: styling methods return their text unchanged, ANSI lookups return no
 * escape sequence, and `name` identifies the host.
 */
export function createUnavailableTheme(onUse?: () => void): Theme {
  let reported = false;
  const used = () => {
    if (reported) return;
    reported = true;
    onUse?.();
  };
  return new Proxy({} as Theme, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      if (THEME_TEXT_STYLES.has(property)) {
        used();
        return (...args: unknown[]) => String(args.at(-1) ?? "");
      }
      if (THEME_ANSI_GETTERS.has(property)) {
        used();
        return () => "";
      }
      if (property === "name") {
        used();
        return "cake";
      }
      return undefined;
    },
  });
}

function boundedProjectionKey(value: string, maximum = 256) {
  if (value.length <= maximum) return value;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${value.slice(0, maximum - digest.length - 1)}:${digest}`;
}
