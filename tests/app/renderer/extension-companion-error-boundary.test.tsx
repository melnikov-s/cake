/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCompanionErrorBoundary } from "../../../src/renderer/components/extension-companion-error-boundary";

function CrashedCompanion(): never {
  throw new Error("Broken companion");
}

function WorkingCompanion() {
  return <p>Working companion</p>;
}

describe("ExtensionCompanionErrorBoundary", () => {
  let container: HTMLDivElement;
  let root: Root;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    consoleError.mockRestore();
  });

  it("recovers when reload publishes a new companion module", () => {
    act(() =>
      root.render(
        <ExtensionCompanionErrorBoundary key="module-v1" name="Fixture">
          <CrashedCompanion />
        </ExtensionCompanionErrorBoundary>,
      ),
    );
    expect(container.textContent).toContain("Fixture could not render");

    act(() =>
      root.render(
        <ExtensionCompanionErrorBoundary key="module-v2" name="Fixture">
          <WorkingCompanion />
        </ExtensionCompanionErrorBoundary>,
      ),
    );

    expect(container.textContent).toContain("Working companion");
    expect(container.textContent).not.toContain("could not render");
  });
});
