import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSkillsFromDir, type LoadSkillsResult } from "@earendil-works/pi-coding-agent";
import prototypeUi from "../skills/prototype-ui/SKILL.md?raw";
import prototypeUiWidget from "../skills/prototype-ui/widget.md?raw";

const bundles = {
  "prototype-ui": { "SKILL.md": prototypeUi, "widget.md": prototypeUiWidget },
};

type SkillsOverride = (base: LoadSkillsResult) => LoadSkillsResult;

/** Bundle readable skill resources, then namespace them through Pi's public loader hook. */
export async function cakeBuiltinSkillsOverride(agentDir: string): Promise<SkillsOverride> {
  const revision = createHash("sha256").update(JSON.stringify(bundles)).digest("hex");
  const directory = join(agentDir, "cake-skills", revision);
  await Promise.all(
    Object.entries(bundles).map(async ([name, files]) => {
      const baseDir = join(directory, name);
      await mkdir(baseDir, { recursive: true });
      await Promise.all(
        Object.entries(files).map(([file, content]) => writeFile(join(baseDir, file), content)),
      );
    }),
  );
  // Parse portable names/frontmatter with Pi, including disable-model-invocation.
  // The Cake-only namespace is applied after validation, not to the Markdown name.
  const bundled = loadSkillsFromDir({ dir: directory, source: "builtin" });
  const skills = bundled.skills.map((skill) => ({ ...skill, name: `cake:${skill.name}` }));
  return (base) => ({
    skills: [...skills, ...base.skills.filter((skill) => !skill.name.startsWith("cake:"))],
    diagnostics: [
      ...base.diagnostics,
      ...bundled.diagnostics,
      ...base.skills
        .filter((skill) => skill.name.startsWith("cake:"))
        .map((skill) => ({
          type: "warning" as const,
          path: skill.filePath,
          message: `Skill "${skill.name}" was not loaded: the cake: namespace is reserved for built-in Cake skills.`,
        })),
    ],
  });
}
