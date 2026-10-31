import { realpath, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Skill, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Tool } from "@earendil-works/pi-ai";
import type { TSchema } from "@earendil-works/pi-ai";
import { Schema } from "effect";
import type { WidgetCandidate } from "../../../contracts/widgets/widget-candidate";
import { jsonValueSchema } from "../../../contracts/serialization/json-contract";
import {
  assertWidgetFileSize,
  isWidgetDirectory,
  widgetPath,
  widgetStatePath,
} from "../../widgets/widget-files";
import { editText } from "../edit-text";
import { canonicalPathIsInsideRoot } from "./workspace-paths";

/** The parent tools a widget side chat reuses as its file tools. */
const widgetFileToolNames = ["read", "write", "edit"] as const;
const isWidgetFileTool = (name: string): name is (typeof widgetFileToolNames)[number] =>
  widgetFileToolNames.some((tool) => tool === name);

const result = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

function page(text: string, offset = 1, limit = 2000) {
  const lines = text.split("\n");
  const selected = lines.slice(offset - 1, offset - 1 + limit).join("\n");
  const bounded = selected.slice(0, 50_000);
  return (
    bounded +
    (offset - 1 + limit < lines.length || bounded.length < selected.length
      ? "\n[Truncated; continue with offset/limit.]"
      : "")
  );
}

const field = (params: unknown, name: string) =>
  typeof params === "object" && params !== null ? Reflect.get(params, name) : undefined;
const stringField = (params: unknown, name: string) => {
  const value = field(params, name);
  if (typeof value !== "string") throw new Error(`Expected string argument: ${name}`);
  return value;
};
const lineField = (params: unknown, name: string) => {
  const value = field(params, name);
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
};
const editsField = (params: unknown) => {
  const edits = field(params, "edits");
  if (
    !Array.isArray(edits) ||
    edits.length === 0 ||
    !edits.every(
      (edit): edit is { oldText: string; newText: string } =>
        typeof field(edit, "oldText") === "string" && typeof field(edit, "newText") === "string",
    )
  )
    throw new Error("Expected edits: [{ oldText, newText }]");
  return edits.map((edit) => ({ oldText: edit.oldText, newText: edit.newText }));
};

function requireWidgetPath(path: string, allowState: boolean) {
  const normalized = widgetPath(path);
  if (!normalized || (normalized === widgetStatePath && !allowState))
    throw new Error(
      `Only widget files can be written here: widget/widget.tsx, widget/widget.html, widget/chooser.tsx, widget/options/<id>.tsx, widget/shared/<id>.tsx${allowState ? " or widget/state.json" : ""}`,
    );
  return normalized;
}

/**
 * A widget side chat must declare exactly the parent's tools: any declaration
 * change becomes a system update, and providers then re-read the whole inherited
 * conversation instead of reusing its prompt cache. So Cake keeps every inherited
 * declaration byte-identical and replaces only what the tools do:
 *
 * - `write`/`edit` change this operation's private widget files.
 * - `read` reads widget files or discovered skill resources.
 * - every other tool refuses.
 */
export async function createWidgetBranchTools(options: {
  cwd: string;
  declarations: ReadonlyArray<Tool>;
  candidate: WidgetCandidate;
  allowState: boolean;
  skills: ReadonlyArray<Skill>;
  onChange?(): void;
}): Promise<ToolDefinition[]> {
  const missing = widgetFileToolNames.filter(
    (name) => !options.declarations.some((tool) => tool.name === name),
  );
  if (missing.length > 0)
    throw new Error(
      `The parent conversation does not declare ${missing.join(", ")}. A widget side chat must reuse the parent's tools to keep its prompt cache, so widget generation is unavailable here.`,
    );
  const roots = await Promise.all(options.skills.map((skill) => realpath(skill.baseDir)));
  const candidate = options.candidate;
  const readText = (path: string) =>
    path === widgetStatePath ? JSON.stringify(candidate.state, null, 2) : candidate.files[path];
  const store = (path: string, text: string) => {
    assertWidgetFileSize(text);
    if (path === widgetStatePath)
      candidate.state = Schema.decodeUnknownSync(Schema.fromJsonString(jsonValueSchema))(text);
    else if (text.trim()) candidate.files[path] = text;
    else delete candidate.files[path];
    options.onChange?.();
  };

  const executors = {
    async read(_id: string, params: unknown, signal: AbortSignal | undefined) {
      signal?.throwIfAborted();
      const requested = stringField(params, "path");
      if (isWidgetDirectory(requested)) {
        const listing = [
          ...Object.entries(candidate.files).map(
            ([path, text]) => `${path} (${Buffer.byteLength(text)} bytes)`,
          ),
          ...(options.allowState ? [widgetStatePath] : []),
        ];
        return result(listing.length > 0 ? listing.join("\n") : "(no widget files yet)");
      }
      const normalized = widgetPath(requested);
      if (normalized) {
        const text = readText(normalized);
        if (text === undefined) throw new Error(`${normalized} has not been written yet`);
        return result(page(text, lineField(params, "offset"), lineField(params, "limit")));
      }
      const path = resolve(options.cwd, requested);
      if (!roots.some((root) => canonicalPathIsInsideRoot(root, path)))
        throw new Error("Only widget files and discovered skill resources may be read here");
      const canonical = await realpath(path);
      // Recheck the exact path that will be opened, not just its spelling.
      if (!roots.some((root) => canonicalPathIsInsideRoot(root, canonical)))
        throw new Error("Skill resource resolves outside its directory");
      const metadata = await stat(canonical);
      if (!metadata.isFile() || metadata.size > 1_048_576)
        throw new Error("Skill resource must be a file no larger than 1 MiB");
      const text = await readFile(canonical, "utf8");
      signal?.throwIfAborted();
      return result(page(text, lineField(params, "offset"), lineField(params, "limit")));
    },
    async write(_id: string, params: unknown, signal: AbortSignal | undefined) {
      signal?.throwIfAborted();
      const path = requireWidgetPath(stringField(params, "path"), options.allowState);
      const content = stringField(params, "content");
      store(path, content);
      return result(
        content.trim()
          ? `Wrote ${path} (${Buffer.byteLength(content)} bytes). Cake compiles and reviews the widget when you finish.`
          : `Removed ${path}.`,
      );
    },
    async edit(id: string, params: unknown, signal: AbortSignal | undefined) {
      const activeSignal = signal ?? new AbortController().signal;
      activeSignal.throwIfAborted();
      const path = requireWidgetPath(stringField(params, "path"), options.allowState);
      const text = readText(path);
      if (text === undefined) throw new Error(`${path} has not been written yet`);
      const edited = await editText({
        workingDirectory: options.cwd,
        path,
        text,
        edits: editsField(params),
        toolCallId: id,
        signal: activeSignal,
      });
      activeSignal.throwIfAborted();
      store(path, edited);
      return result(`Edited ${path}.`);
    },
  } satisfies Record<(typeof widgetFileToolNames)[number], ToolDefinition["execute"]>;
  const refuse = (name: string) => async () => {
    throw new Error(
      `${name} is unavailable while building a widget. Use read, write and edit on widget/ files only.`,
    );
  };

  return options.declarations.map((declaration) => {
    const name = declaration.name;
    const tool: ToolDefinition = {
      name,
      label: name,
      description: declaration.description,
      // SAFETY: the inherited declaration is the JSON Schema Pi recorded for this tool.
      parameters: declaration.parameters as TSchema,
      executionMode: "sequential",
      execute: isWidgetFileTool(name) ? executors[name] : refuse(name),
    };
    // Declarations compare constrained sampling too, so it must match exactly.
    if (declaration.constrainedSampling !== undefined)
      tool.constrainedSampling = declaration.constrainedSampling;
    return tool;
  });
}
