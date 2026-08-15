import { DefaultPackageManager, type DefaultResourceLoader, type ExtensionUIContext, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import type { CompatibilityCatalog, ExtensionUiEvent, ExtensionUiState, ResourceDiagnostic } from "../ipc/session-contract";
import type { RuntimeUiRequest } from "./cake-runtime";

export function compatibilityCatalog(
  resourceLoader: DefaultResourceLoader,
  settingsManager: SettingsManager,
  cwd: string,
  agentDir: string
): CompatibilityCatalog {
  const extensions = resourceLoader.getExtensions();
  const skills = resourceLoader.getSkills();
  const prompts = resourceLoader.getPrompts();
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager }).listConfiguredPackages();
  const resources: CompatibilityCatalog["resources"] = [];

  for (const skill of skills.skills) resources.push({
    id: `skill:${skill.filePath}`.slice(0, 8_192), kind: "skill", name: skill.name,
    description: skill.description, path: skill.filePath, source: skill.sourceInfo.source,
    scope: skill.sourceInfo.scope, origin: skill.sourceInfo.origin, commands: [], tools: [], enabled: true
  });
  for (const prompt of prompts.prompts) resources.push({
    id: `prompt:${prompt.filePath}`.slice(0, 8_192), kind: "prompt", name: prompt.name,
    description: prompt.description, path: prompt.filePath, source: prompt.sourceInfo.source,
    scope: prompt.sourceInfo.scope, origin: prompt.sourceInfo.origin, commands: [], tools: [], enabled: true
  });
  for (const extension of extensions.extensions) resources.push({
    id: `extension:${extension.resolvedPath}`.slice(0, 8_192), kind: "extension",
    name: extension.path.split(/[\\/]/).pop() ?? extension.path, path: extension.path,
    source: extension.sourceInfo.source, scope: extension.sourceInfo.scope,
    origin: extension.sourceInfo.origin, commands: [...extension.commands.keys()].filter((name) => name.length <= 256).sort(),
    tools: [...extension.tools.keys()].filter((name) => name.length <= 256).sort(), enabled: !extension.hidden
  });
  for (const configured of packages) resources.push({
    id: `package:${configured.scope}:${configured.source}`.slice(0, 8_192), kind: "package",
    name: configured.source, path: configured.installedPath, source: configured.source,
    scope: configured.scope, origin: "package", commands: [], tools: [], enabled: !configured.filtered
  });

  const diagnostics: ResourceDiagnostic[] = [
    ...extensions.errors.map((error, index) => ({ id: `extension:${index}:${error.path}`, severity: "error" as const, source: "extension" as const, message: error.error, path: error.path })),
    ...skills.diagnostics.map((item, index) => ({ id: `skill:${index}:${item.path ?? item.message}`.slice(0, 8_192), severity: item.type === "error" ? "error" as const : "warning" as const, source: "skill" as const, message: item.message, path: item.path })),
    ...resourceLoader.getPrompts().diagnostics.map((item, index) => ({ id: `prompt:${index}:${item.path ?? item.message}`.slice(0, 8_192), severity: item.type === "error" ? "error" as const : "warning" as const, source: "prompt" as const, message: item.message, path: item.path }))
  ];
  return { resources, diagnostics };
}

export function createCakeExtensionUiContext(options: {
  request(request: RuntimeUiRequest): Promise<string | undefined>;
  emit(event: ExtensionUiEvent): void;
  state: ExtensionUiState;
  addDiagnostic(method: string, message: string): void;
}): ExtensionUIContext {
  let editorText = "";
  const degraded = (method: string, detail: string) => options.addDiagnostic(method, `${method} is unavailable in Cake: ${detail}`);
  const dialog = (request: RuntimeUiRequest) => options.request(request);
  return {
    async select(title, values, opts) {
      const projected = values.slice(0, 100).map((value) => ({ id: boundedProjectionKey(value), label: value, value }));
      const selected = await dialog({ kind: "select", title, message: title, options: projected.map(({ id, label }) => ({ id, label })), signal: opts?.signal, timeout: opts?.timeout });
      return projected.find((option) => option.id === selected)?.value;
    },
    async confirm(title, message, opts) { return (await dialog({ kind: "confirm", title, message, signal: opts?.signal, timeout: opts?.timeout })) === "true"; },
    input: (title, placeholder, opts) => dialog({ kind: "text", title, message: title, placeholder, signal: opts?.signal, timeout: opts?.timeout }),
    notify(message, tone = "info") { options.emit({ kind: "notify", id: crypto.randomUUID(), message, tone }); },
    onTerminalInput() { degraded("onTerminalInput", "raw terminal input has no desktop equivalent"); return () => undefined; },
    setStatus(key, text) {
      key = boundedProjectionKey(key);
      const index = options.state.statuses.findIndex((status) => status.key === key);
      if (text === undefined) { if (index >= 0) options.state.statuses.splice(index, 1); }
      else if (index >= 0) options.state.statuses.splice(index, 1, { key, text });
      else options.state.statuses.push({ key, text });
      options.emit({ kind: "status", key, text });
    },
    setWorkingMessage(message) { degraded("setWorkingMessage", message ? "Cake owns its streaming indicator" : "Cake owns its streaming indicator"); },
    setWorkingVisible() { degraded("setWorkingVisible", "Cake owns streaming visibility"); },
    setWorkingIndicator() { degraded("setWorkingIndicator", "terminal animation frames are not web UI"); },
    setHiddenThinkingLabel() { degraded("setHiddenThinkingLabel", "Cake uses its accessible reasoning label"); },
    setWidget() { degraded("setWidget", "terminal widgets cannot run in the Cake renderer; use a Cake artifact"); },
    setFooter() { degraded("setFooter", "terminal footer factories cannot run in the renderer"); },
    setHeader() { degraded("setHeader", "terminal header factories cannot run in the renderer"); },
    setTitle(title) { options.state.title = title; options.emit({ kind: "title", title }); },
    async custom() { degraded("custom", "arbitrary TUI components require a Cake artifact or widget fallback"); return undefined as never; },
    pasteToEditor(text) { editorText += text; options.emit({ kind: "editor-text", text, mode: "insert" }); },
    setEditorText(text) { editorText = text; options.emit({ kind: "editor-text", text, mode: "replace" }); },
    getEditorText: () => editorText,
    editor: (title, prefill) => dialog({ kind: "editor", title, message: title, initialValue: prefill ?? "", multiline: true }),
    addAutocompleteProvider() { degraded("addAutocompleteProvider", "terminal autocomplete providers cannot attach to the web composer"); },
    setEditorComponent() { degraded("setEditorComponent", "terminal editor components cannot replace the web composer"); },
    getEditorComponent: () => undefined,
    get theme() { degraded("theme", "Pi TUI themes are not Cake renderer themes"); return unsupported("theme"); },
    getAllThemes: () => [],
    getTheme(name) { degraded("getTheme", `Pi TUI theme ${name} is unavailable`); return undefined; },
    setTheme() { degraded("setTheme", "extensions cannot replace Cake's renderer theme"); return { success: false, error: "Pi TUI themes are unavailable in Cake" }; },
    getToolsExpanded: () => false,
    setToolsExpanded() { degraded("setToolsExpanded", "tool expansion is controlled by the Cake transcript"); }
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
