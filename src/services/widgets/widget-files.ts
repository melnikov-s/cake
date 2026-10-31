import type { InlineWidgetLanguage } from "../../contracts/widgets/inline-widget-contract";
import type { PrototypeModule, PrototypeSource } from "../../contracts/widgets/prototype-source";
import type { WidgetCandidate } from "../../contracts/widgets/widget-candidate";
import { moduleImports, prototypeModuleSpecifier, readPrototypeSource } from "./prototype-source";

/**
 * The widget side chat writes source as named files instead of returning one
 * reply. Cake owns the mapping between those files and the published source:
 *
 * - `widget/widget.tsx`: an ordinary React widget or Session Plugin.
 * - `widget/widget.html`: a self-contained HTML widget.
 * - `widget/chooser.tsx`, `widget/options/<id>.tsx`, `widget/shared/<id>.tsx`:
 *   a five-option prototype-ui widget, assembled into cake.prototype-source/v1.
 * - `widget/state.json`: the staged artifact JSON state (not part of the source).
 */
export const widgetStatePath = "widget/state.json";
const widgetDirectory = "widget";
const maximumFileBytes = 1_048_576;
const moduleId = "[a-z][a-z0-9-]{0,63}";
const sourcePath = new RegExp(
  `^widget/(?:widget\\.tsx|widget\\.html|chooser\\.tsx|(?:options|shared)/${moduleId}\\.tsx)$`,
);

/** Normalizes a model-supplied path; undefined when it is not a widget path. */
export function widgetPath(path: string): string | undefined {
  const normalized = path.trim().replace(/^\.\//, "");
  if (normalized === widgetStatePath || sourcePath.test(normalized)) return normalized;
  return undefined;
}

/** Whether a read targets the widget directory listing rather than one file. */
export function isWidgetDirectory(path: string) {
  const normalized = path.trim().replace(/^\.\//, "").replace(/\/$/, "");
  return normalized === widgetDirectory;
}

export function assertWidgetFileSize(text: string) {
  if (Buffer.byteLength(text) > maximumFileBytes)
    throw new Error("A widget file may not exceed 1 MiB");
}

const fileModuleId = (path: string) => path.slice(path.lastIndexOf("/") + 1, -".tsx".length);

/** Assembles the side chat's files into the exact source Cake compiles and publishes. */
export function assembleWidgetSource(
  files: Readonly<WidgetCandidate["files"]>,
  language: InlineWidgetLanguage,
): string {
  const paths = Object.keys(files).filter((path) => path !== widgetStatePath);
  if (language === "html") {
    const extra = paths.filter((path) => path !== "widget/widget.html");
    if (extra.length > 0)
      throw new Error(
        `HTML widgets use only widget/widget.html; write empty content to remove ${extra.join(", ")}`,
      );
    const source = files["widget/widget.html"]?.trim();
    if (!source) throw new Error("Write the complete HTML document to widget/widget.html");
    if (!/^<!doctype html>\s*<html[\s>][\s\S]*<\/html>$/i.test(source))
      throw new Error(
        "widget/widget.html must be one complete <!doctype html><html>...</html> document",
      );
    return source;
  }
  if (paths.includes("widget/widget.html"))
    throw new Error(
      "React widgets cannot use widget/widget.html; write empty content to remove it",
    );
  const chooser = files["widget/chooser.tsx"];
  const optionPaths = paths.filter((path) => path.startsWith("widget/options/"));
  const sharedPaths = paths.filter((path) => path.startsWith("widget/shared/"));
  if (chooser === undefined) {
    if (optionPaths.length > 0 || sharedPaths.length > 0)
      throw new Error("A prototype widget requires widget/chooser.tsx");
    const source = files["widget/widget.tsx"]?.trim();
    if (!source) throw new Error("Write the React component to widget/widget.tsx");
    return source;
  }
  if (paths.includes("widget/widget.tsx"))
    throw new Error(
      "A prototype widget uses widget/chooser.tsx; write empty content to remove widget/widget.tsx",
    );
  if (optionPaths.length !== 5)
    throw new Error(
      `A prototype widget needs exactly five widget/options/<id>.tsx files; found ${optionPaths.length}`,
    );
  const module = (id: string, source: string): PrototypeModule => ({
    id,
    source,
    dependencies: [...moduleImports({ id, source })],
  });
  const chooserModule = module("chooser", chooser);
  // Options appear in the order the chooser imports them, then any remainder by name.
  const importOrder = chooserModule.dependencies;
  const optionIds = optionPaths.map(fileModuleId).toSorted((left, right) => {
    const rank = (id: string) => {
      const index = importOrder.indexOf(prototypeModuleSpecifier(id));
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    return rank(left) - rank(right) || left.localeCompare(right);
  });
  const bundle: PrototypeSource = {
    schema: "cake.prototype-source/v1",
    chooser: chooserModule,
    options: optionIds.map((id) => module(id, files[`widget/options/${id}.tsx`]!)),
    shared: sharedPaths
      .map(fileModuleId)
      .toSorted()
      .map((id) => module(id, files[`widget/shared/${id}.tsx`]!)),
  };
  const source = `export default ${JSON.stringify(bundle, null, 2)};`;
  readPrototypeSource(source);
  return source;
}

/** Splits accepted source back into the files a revision edits. */
export function widgetFilesFromSource(
  source: string,
  language: InlineWidgetLanguage,
): WidgetCandidate["files"] {
  if (language === "html") return { "widget/widget.html": source };
  const prototype = readPrototypeSource(source);
  if (!prototype) return { "widget/widget.tsx": source };
  return Object.fromEntries([
    ["widget/chooser.tsx", prototype.chooser.source],
    ...prototype.options.map((option) => [`widget/options/${option.id}.tsx`, option.source]),
    ...prototype.shared.map((shared) => [`widget/shared/${shared.id}.tsx`, shared.source]),
  ]);
}
