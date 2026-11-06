import { DefaultResourceLoader, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cakeBuiltinSkillsOverride } from "../../../../src/services/pi/runtime/cake-builtin-skills";
import { createWidgetBranchTools } from "../../../../src/services/pi/runtime/widget-branch-tools";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cake-builtin-skills-"));
  directories.push(root);
  const agentDir = join(root, "agent");
  const override = await cakeBuiltinSkillsOverride(agentDir);
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    skillsOverride: override,
  });
  await loader.reload({ resolveProjectTrust: async () => false });
  return { root, agentDir, override, loader };
}

describe("built-in Cake skills", () => {
  it("loads portable bundled resources under the Cake namespace with lazy discovery", async () => {
    const { agentDir, loader } = await fixture();
    const { skills, diagnostics } = loader.getSkills();
    const prototype = skills.find((skill) => skill.name === "cake:prototype-ui")!;
    expect(prototype).toMatchObject({
      description: expect.stringContaining("five alternatives"),
      disableModelInvocation: false,
      sourceInfo: { source: "builtin" },
    });
    expect(prototype.filePath.startsWith(join(agentDir, "cake-skills"))).toBe(true);
    expect(diagnostics).toEqual([]);
    const instructions = await readFile(prototype.filePath, "utf8");
    expect(instructions).toContain("name: prototype-ui");
    expect(instructions).toContain("selectedOptionId");
    expect(instructions).toContain("artifacts.state.read");
    const prompt = formatSkillsForPrompt(skills);
    expect(prompt).toContain("cake:prototype-ui");
    expect(prompt).toContain(prototype.filePath);
    expect(prompt).not.toContain("## Gather the app's design context");
    const again = await cakeBuiltinSkillsOverride(agentDir);
    expect(again({ skills: [], diagnostics: [] }).skills[0]!.filePath).toBe(prototype.filePath);
    await loader.reload();
    expect(loader.getSkills().skills.filter((skill) => skill.name === prototype.name)).toHaveLength(
      1,
    );
  });

  it("packages surface-specific styling, readable viewports and rendered visual checks", async () => {
    const { loader } = await fixture();
    const prototype = loader
      .getSkills()
      .skills.find((skill) => skill.name === "cake:prototype-ui")!;
    const skill = await readFile(prototype.filePath, "utf8");
    for (const fact of [
      "`html.present` uses an isolated iframe with no inherited Cake CSS variables",
      "Define every required CSS variable locally",
      "HTML/React widgets receive live host theme tokens",
      "do not shrink fonts or scale whole screens to fit five across",
      "Overview thumbnails may supplement, never replace",
      "Inspect actual rendered pixels for every alternative",
      "Fix defects and inspect the revised rendering",
      "“published, visually unverified”",
      "`artifacts.preview` is for widgets only",
    ])
      expect(skill).toContain(fact);
    const widget = await readFile(join(prototype.baseDir, "widget.md"), "utf8");
    expect(widget).toContain("never shrink five screens to unreadable thumbnails");
    expect(widget).toContain("The host supplies semantic color/font variables before first paint");
    expect(widget).toContain("updates them live");
  });

  it("keeps ordinary project skill names and reserves the Cake namespace for bundled skills", async () => {
    const { root, override, loader } = await fixture();
    const directory = join(root, "project-skill");
    await mkdir(directory);
    await writeFile(
      join(directory, "SKILL.md"),
      "---\nname: prototype-ui\ndescription: Project-specific prototype workflow\n---\nProject instructions.",
    );
    const project = {
      ...loader.getSkills().skills[0]!,
      name: "prototype-ui",
      filePath: join(directory, "SKILL.md"),
    };
    const manual = { ...project, name: "manual", disableModelInvocation: true };
    const collision = { ...project, name: "cake:prototype-ui" };
    const result = override({ skills: [project, manual, collision], diagnostics: [] });
    expect(result.skills.map((skill) => skill.name)).toEqual([
      "cake:prototype-ui",
      "prototype-ui",
      "manual",
    ]);
    expect(result.skills.find((skill) => skill.name === "cake:prototype-ui")!.filePath).not.toBe(
      project.filePath,
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        type: "warning",
        path: project.filePath,
        message: expect.stringContaining("reserved"),
      }),
    );
    expect(formatSkillsForPrompt(result.skills)).not.toContain("<name>manual</name>");
    expect(result.skills.find((skill) => skill.name === "manual")!.disableModelInvocation).toBe(
      true,
    );
  });

  it("lets restricted widget specialists read the bundled chooser contract, not arbitrary project files", async () => {
    const { root, loader } = await fixture();
    const skills = loader.getSkills().skills;
    const prototype = skills.find((skill) => skill.name === "cake:prototype-ui")!;
    const declaration = (name: string) => ({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
    });
    const tools = await createWidgetBranchTools({
      cwd: root,
      declarations: ["read", "write", "edit"].map(declaration),
      candidate: { files: {}, state: null },
      allowState: true,
      skills,
    });
    const read = tools.find((tool) => tool.name === "read")!;
    const result = await read.execute(
      "read-contract",
      { path: join(prototype.baseDir, "widget.md") },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("cake.prototype-ui/v1"),
      }),
    );
    const projectFile = join(root, "DESIGN.md");
    await writeFile(projectFile, "Parent-only design research");
    await expect(
      read.execute("read-project", { path: projectFile }, undefined, undefined, {} as never),
    ).rejects.toThrow("Only widget files and discovered skill resources");
  });
});
