import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import commonPrompt from "../../../src/services/pi/runtime/prompts/common.md?raw";
import projectTemplate from "../../../src/services/pi/runtime/prompts/project.md?raw";
import { renderPromptTemplate } from "../../../src/services/pi/runtime/prompt-template";
import { coordinatorSystemPrompt } from "../../../src/services/pi-durable/coordinator-system-prompt";

const example = commonPrompt.match(/```js\n([\s\S]*?)\n```/)![1]!;

type Excerpt = {
  path: string;
  matches?: string[];
  excerptOnly?: boolean;
  error?: string;
};

async function runExample(
  read: (input: { path: string; offset: number; limit: number }) => Promise<string>,
) {
  const output: Excerpt[] = [];
  await runInNewContext(`(async () => { ${example} })()`, {
    tools: { read },
    text: (value: Excerpt) => output.push(value),
  });
  return output;
}

describe("codemode output guidance", () => {
  it("ships the same task-relevant output rule to Project Sessions and Cake Chat", () => {
    const project = renderPromptTemplate(projectTemplate, {
      commonPrompt,
      cakeDocsDirectory: "/cake/docs",
    });
    for (const prompt of [project, coordinatorSystemPrompt("", "/cake/docs")]) {
      expect(prompt).toContain(
        "print bounded fields/excerpts, not whole-file/document batches or raw result arrays",
      );
      expect(prompt).toContain(example);
    }
  });

  it("demonstrates bounded reads and task-relevant printing, labeling incomplete excerpts", async () => {
    const body = Array.from({ length: 80 }, (_, index) =>
      index % 2 === 0 ? `target ${index}` : `unrelated ${index}`,
    ).join("\n");
    const read = vi.fn(async () => body);
    const output = await runExample(read);
    expect(read.mock.calls).toEqual([
      [{ path: "src/a.ts", offset: 1, limit: 80 }],
      [{ path: "src/b.ts", offset: 1, limit: 80 }],
    ]);
    expect(output).toEqual(
      ["src/a.ts", "src/b.ts"].map((path) => ({
        path,
        matches: Array.from({ length: 12 }, (_, index) => `target ${index * 2}`),
        excerptOnly: true,
      })),
    );
  });

  it("uses allSettled so a failed independent read remains visible beside successful output", async () => {
    expect(example).toContain("Promise.allSettled");
    const read = vi.fn(async ({ path }: { path: string }) => {
      if (path === "src/a.ts") throw new Error("Cannot read src/a.ts");
      return "unrelated\ntarget found";
    });
    expect(await runExample(read)).toEqual([
      { path: "src/a.ts", error: "Error: Cannot read src/a.ts" },
      { path: "src/b.ts", matches: ["target found"], excerptOnly: true },
    ]);
    expect(commonPrompt).toContain("show every rejection and tool-returned failure explicitly");
  });

  it("preserves required complete reads and makes omissions a reason to inspect further", () => {
    expect(commonPrompt).toContain("Required complete reads (especially Pi docs) still apply");
    expect(commonPrompt).toContain("read all pages without filtering required content");
    expect(commonPrompt).toContain("in separate calls to avoid aggregate truncation");
    expect(commonPrompt).toContain(
      "Check truncation/omissions and read more before claiming completeness",
    );
    expect(commonPrompt).toContain("excerpt-only text-file inspection");
  });
});
