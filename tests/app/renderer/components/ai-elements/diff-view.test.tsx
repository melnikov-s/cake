/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffView } from "../../../../../src/renderer/components/ai-elements/diff-view";
import { languageForSource } from "../../../../../src/renderer/components/ai-elements/code";

async function waitForSyntaxTokens(container: HTMLElement) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (container.querySelector(".syntax-token")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("DiffView", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("preserves indentation and highlights the file language", async () => {
    await act(async () => {
      root.render(
        <DiffView
          filePath="src/app.ts"
          diff={"@@ -1,0 +1,2 @@\n+  const value = true;\n+\treturn value;"}
        />,
      );
      await waitForSyntaxTokens(container);
    });

    const rows = [...container.querySelectorAll<HTMLElement>(".diff-line:not(.diff-meta)")];
    expect(rows[0]?.querySelector("code")?.textContent).toBe("+  const value = true;");
    expect(rows[1]?.querySelector("code")?.textContent).toBe("+\treturn value;");
    expect(container.querySelector(".syntax-token")).not.toBeNull();
  });

  it("copies the file path from the diff header", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    act(() => {
      root.render(<DiffView filePath="src/app.ts" diff="@@ -1 +1 @@\n-old\n+new" />);
    });

    const copy = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy src/app.ts"]',
    )!;
    await act(async () => copy.click());

    expect(writeText).toHaveBeenCalledWith("src/app.ts");
    expect(copy.getAttribute("aria-label")).toBe("Copied src/app.ts");
  });

  it("maps common source extensions to syntax languages", () => {
    expect(languageForSource("src/app.ts")).toBe("typescript");
    expect(languageForSource("src/app.js")).toBe("javascript");
    expect(languageForSource("src/styles.css")).toBe("css");
    expect(languageForSource("src/index.html")).toBe("html");
  });
});
