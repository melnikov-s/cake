/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultApplicationState,
  defaultProjectSettings,
} from "../../../src/contracts/application/application-data";
import type { Client } from "../../../src/renderer/client/Client";
import { ProjectSettingsDialog } from "../../../src/renderer/components/project-settings-dialog";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { configurationModel } from "./chat-configuration-workflow-fixture";
import type { TestClientOverrides } from "./test-client";

const artwork = {
  background: "#112233",
  paths: [{ d: "M10 10 L90 10 L50 90 Z", fill: "#abcdef" }],
};
const original = { mimeType: "image/png" as const, data: "b3JpZ2luYWw=" };
const path = "/work/cake";

function setup(client: TestClientOverrides = {}) {
  const fixture = createRendererStoreFixture({
    projects: [
      projectRecord({
        path,
        name: "Cake",
        settings: { ...defaultProjectSettings(), icon: original },
      }),
    ],
    client,
  });
  const store = fixture.root.projectSettingsStore;
  store.open(path);
  const view = render(<ProjectSettingsDialog store={store} />);
  return {
    store,
    root: fixture.root,
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: true,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("project icon generation workflow", () => {
  it("makes no model request on open, rename or model selection; Generate defaults to utility and reuses the chosen default model", async () => {
    const generateProjectIcon = vi.fn<Client["workspaces"]["generateProjectIcon"]>(
      async () => artwork,
    );
    using fixture = setup({ workspaces: { generateProjectIcon } });
    await fixture.user.type(screen.getByRole("textbox", { name: "Project name" }), " desktop");
    expect(generateProjectIcon).not.toHaveBeenCalled();
    await fixture.user.click(screen.getByRole("button", { name: "Generate" }));
    expect(generateProjectIcon).toHaveBeenLastCalledWith(
      { name: "Cake desktop", model: { source: "utility" } },
      expect.anything(),
    );
    expect(await screen.findByRole("img", { name: "Generated icon preview" })).toBeDefined();
    expect(fixture.store.identity.icon).toEqual(original);
    await fixture.user.click(screen.getByRole("button", { name: "Icon generation model" }));
    expect(screen.getByText("Current: Utility model")).toBeDefined();
    await fixture.user.click(screen.getByRole("radio", { name: "Default model" }));
    expect(generateProjectIcon).toHaveBeenCalledTimes(1);
    await fixture.user.click(screen.getByRole("textbox", { name: "Project name" }));
    await fixture.user.click(screen.getByRole("button", { name: "Generate" }));
    await fixture.user.click(screen.getByRole("button", { name: "Generate" }));
    expect(generateProjectIcon).toHaveBeenCalledTimes(3);
    expect(generateProjectIcon.mock.calls.slice(1).map(([input]) => input.model)).toEqual([
      { source: "default" },
      { source: "default" },
    ]);
    expect(fixture.store.identity.icon).toEqual(original);
  });

  it("chooses a specific available language model through the existing picker without generating until clicked", async () => {
    const generateProjectIcon = vi.fn<Client["workspaces"]["generateProjectIcon"]>(
      async () => artwork,
    );
    using fixture = setup({
      models: { list: async () => [configurationModel({ availableThinkingLevels: ["off"] })] },
      workspaces: { generateProjectIcon },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Icon generation model" }));
    await fixture.user.click(screen.getByRole("button", { name: "Choose icon generation model" }));
    await fixture.user.click(await screen.findByRole("button", { name: /GPT-5/ }));
    await fixture.user.click(screen.getByRole("button", { name: "Apply" }));
    expect(generateProjectIcon).not.toHaveBeenCalled();
    await fixture.user.click(screen.getByRole("textbox", { name: "Project name" }));
    await fixture.user.click(screen.getByRole("button", { name: "Generate" }));
    expect(generateProjectIcon).toHaveBeenCalledWith(
      {
        name: "Cake",
        model: {
          source: "model",
          model: { provider: "openai", modelId: "gpt-5", thinkingLevel: "off", fastMode: false },
        },
      },
      expect.anything(),
    );
  });

  it("rejects unsafe SVG geometry and model failures without replacing the current icon", async () => {
    const generateProjectIcon = vi
      .fn<Client["workspaces"]["generateProjectIcon"]>()
      .mockResolvedValueOnce({
        ...artwork,
        paths: [{ d: 'M0 0" onload="alert(1)', fill: "#ffffff" }],
      })
      .mockRejectedValueOnce(new Error("The chosen model is unavailable"));
    using fixture = setup({ workspaces: { generateProjectIcon } });
    await fixture.user.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Unsupported SVG geometry",
    );
    expect(fixture.store.identity.icon).toEqual(original);
    expect(screen.queryByRole("img", { name: "Generated icon preview" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "The chosen model is unavailable",
    );
    expect(fixture.store.identity.icon).toEqual(original);
  });

  it("previews valid SVG, rasterizes only on acceptance, and saves PNG through the existing icon contract", async () => {
    const generateProjectIcon = vi.fn<Client["workspaces"]["generateProjectIcon"]>(
      async () => artwork,
    );
    const setProjectSettings = vi.fn<Client["workspaces"]["setProjectSettings"]>(async () =>
      defaultApplicationState(),
    );
    const drawImage = vi.fn();
    const contextDescriptor = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      "getContext",
    );
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => ({ drawImage }),
    });
    const png = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/png;base64,cG5n");
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | undefined;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    try {
      using fixture = setup({ workspaces: { generateProjectIcon, setProjectSettings } });
      await fixture.user.click(screen.getByRole("button", { name: "Generate" }));
      expect(await screen.findByRole("img", { name: "Generated icon preview" })).toBeDefined();
      expect(drawImage).not.toHaveBeenCalled();
      expect(png).not.toHaveBeenCalled();
      await fixture.user.click(screen.getByRole("button", { name: "Use icon" }));
      await waitFor(() =>
        expect(screen.queryByRole("img", { name: "Generated icon preview" })).toBeNull(),
      );
      expect(drawImage).toHaveBeenCalledOnce();
      expect(png).toHaveBeenCalledWith("image/png");
      expect(fixture.store.identity.icon).toEqual({ mimeType: "image/png", data: "cG5n" });
      expect(setProjectSettings).not.toHaveBeenCalled();
      await fixture.user.click(screen.getByRole("button", { name: "Save settings" }));
      expect(setProjectSettings).toHaveBeenCalledWith(
        path,
        expect.objectContaining({ icon: { mimeType: "image/png", data: "cG5n" } }),
        expect.anything(),
      );
    } finally {
      if (contextDescriptor)
        Object.defineProperty(HTMLCanvasElement.prototype, "getContext", contextDescriptor);
    }
  });

  it("discards a generated preview on cancel and ignores a late result from the closed dialog", async () => {
    let resolve: ((value: typeof artwork) => void) | undefined;
    const pending = new Promise<typeof artwork>((complete) => {
      resolve = complete;
    });
    const generateProjectIcon = vi.fn<Client["workspaces"]["generateProjectIcon"]>(() => pending);
    using fixture = setup({ workspaces: { generateProjectIcon } });
    await fixture.user.click(screen.getByRole("button", { name: "Generate" }));
    await fixture.user.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => resolve?.(artwork));
    await act(() => fixture.store.open(path));
    expect(fixture.store.identity.preview).toBeUndefined();
    expect(fixture.store.identity.icon).toEqual(original);
    expect(fixture.store.identity.model).toEqual({ source: "utility" });
    expect(generateProjectIcon.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
