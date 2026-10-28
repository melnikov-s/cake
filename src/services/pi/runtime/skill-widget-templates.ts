import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Result, Schema } from "effect";
import type {
  ResolveWidgetTemplate,
  WidgetTemplate,
} from "../../../contracts/widgets/widget-template";
import { inlineWidgetLanguageSchema } from "../../../contracts/widgets/inline-widget-contract";
import type { WidgetBrowserOutput } from "../../../contracts/widgets/widget-browser-output";
import { canonicalPathIsInsideRoot } from "./workspace-paths";

const Manifest = Schema.Struct({
  source: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  language: inlineWidgetLanguageSchema,
});
const FsError = Schema.Struct({ code: Schema.String });

/** Prepare opted-in skill renderers at session startup, not on the document request path.
 * Uses the existing compiler/package environment; never installs dependencies or changes settings.
 * The resulting map is a session resource snapshot, not another artifact or mutable document.
 */
export async function prepareSkillWidgetTemplates(
  skills: ReadonlyArray<{ name: string; baseDir: string }>,
  compile:
    | ((language: WidgetTemplate["language"], source: string) => Promise<WidgetBrowserOutput>)
    | undefined,
): Promise<ResolveWidgetTemplate> {
  const prepared = await Promise.allSettled(
    skills.map(async (skill) => {
      let manifestText: string;
      try {
        manifestText = await readFile(resolve(skill.baseDir, "widget.json"), "utf8");
      } catch (error) {
        const decoded = Schema.decodeUnknownOption(FsError)(error);
        if (decoded._tag === "Some" && decoded.value.code === "ENOENT") return undefined;
        throw error;
      }
      const manifest = Schema.decodeUnknownResult(Schema.fromJsonString(Manifest))(manifestText);
      if (Result.isFailure(manifest)) throw new Error(`Invalid widget.json: ${manifest.failure}`);
      const root = await realpath(skill.baseDir);
      const path = await realpath(resolve(root, manifest.success.source));
      if (!canonicalPathIsInsideRoot(root, path))
        throw new Error("Widget template source must stay inside its skill directory");
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > 1_048_576)
        throw new Error("Widget template source must be a file no larger than 1 MiB");
      const source = await readFile(path, "utf8");
      if (!compile) throw new Error("Widget template preparation is unavailable in this session");
      const language = manifest.success.language;
      return { source, language, browser: await compile(language, source) };
    }),
  );
  const entries = new Map<string, (typeof prepared)[number]>();
  prepared.forEach((entry, index) => {
    const skill = skills[index];
    if (skill) entries.set(skill.name, entry);
  });
  return (skill) => {
    const entry = entries.get(skill);
    if (!entry)
      throw new Error(
        `Widget template skill ${JSON.stringify(skill)} is not loaded in this session`,
      );
    if (entry.status === "rejected")
      throw new Error(
        `Widget template ${JSON.stringify(skill)} could not be prepared: ${String(entry.reason)}`,
      );
    if (!entry.value) throw new Error(`Skill ${JSON.stringify(skill)} does not supply widget.json`);
    return entry.value;
  };
}
