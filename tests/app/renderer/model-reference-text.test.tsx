/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  serializeModelReference,
  splitModelReferences,
} from "../../../src/contracts/model-presets/model-reference";
import { Markdown } from "../../../src/renderer/components/ai-elements/markdown";
import { ModelReferenceText } from "../../../src/renderer/components/model-reference-text";

const model = {
  provider: "openai-codex",
  modelId: "sol",
  thinkingLevel: "high" as const,
  fastMode: true,
};
afterEach(cleanup);
describe("model reference message text", () => {
  it("round-trips multiple references, surrounding text, newlines and explicit false/off", () => {
    const first = serializeModelReference(model);
    const second = serializeModelReference({
      ...model,
      modelId: "other/model",
      thinkingLevel: "off",
      fastMode: false,
    });
    const text = `Use ${first} here,\nand ${second} there.`;
    const parts = splitModelReferences(text);
    expect(parts.map((part) => part.text).join("")).toBe(text);
    expect(parts.filter((part) => part.model).map((part) => part.model)).toEqual([
      model,
      { ...model, modelId: "other/model", thinkingLevel: "off", fastMode: false },
    ]);
    for (const part of parts) expect(text.slice(part.start, part.end)).toBe(part.text);
  });
  it("retains preset identity and prompt even with tag-like text in guidance", () => {
    const preset = {
      ...model,
      preset: {
        id: "00000000-0000-4000-8000-000000000001",
        prompt: "Use </cake-model>\nand [brackets]",
      },
      presetName: "Sol",
    };
    const serialized = serializeModelReference(preset);
    expect(serialized.match(/<\/cake-model>/g)).toHaveLength(1);
    expect(splitModelReferences(serialized)[0]?.model).toEqual(preset);
  });
  it("leaves invalid tokens literal", () => {
    for (const text of [
      "<cake-model>oops</cake-model>",
      '<cake-model>{"provider":"x"}</cake-model>',
      '<cake-model>{"provider":"x","modelId":"y","thinkingLevel":"bogus","fastMode":true}</cake-model>',
    ])
      expect(splitModelReferences(text)).toEqual([{ text, start: 0, end: text.length }]);
  });
  it("preserves surrounding Markdown formatting and quoted code while rendering sent references", () => {
    const token = serializeModelReference(model);
    const view = render(
      <Markdown
        renderModelReferences
        onOpenSourceLocation={() => {}}
      >{`**Use** ${token} for review.\n\n\`\`\`text\n${token}\n\`\`\``}</Markdown>,
    );
    expect(view.container.querySelector('[data-streamdown="strong"]')?.textContent).toBe("Use");
    expect(view.container.querySelector('[data-slot="model-reference"]')?.textContent).toBe(
      "sol · high · Fast",
    );
    expect(
      view.container.querySelector('[data-streamdown="code-block-body"]')?.textContent,
    ).toContain(token);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("renders compact sent references without buttons or editable controls", () => {
    const text = `Use ${serializeModelReference(model)} and ${serializeModelReference({ ...model, presetName: "Preset", preset: { id: "00000000-0000-4000-8000-000000000001" } })}.`;
    const view = render(<ModelReferenceText text={text} />);
    expect(screen.getByText("sol · high · Fast")).toBeTruthy();
    expect(screen.getByText("Preset · high · Fast")).toBeTruthy();
    expect(view.container.textContent).toBe("Use sol · high · Fast and Preset · high · Fast.");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
