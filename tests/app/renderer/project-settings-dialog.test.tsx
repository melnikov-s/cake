/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultApplicationState,
  defaultProjectSettings,
  type ProjectSettings,
  PROJECT_ICON_DATA_MAX_LENGTH,
} from "../../../src/contracts/application/application-data";
import { ProjectSettingsDialog } from "../../../src/renderer/components/project-settings-dialog";
import type { Client } from "../../../src/renderer/client/Client";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

const projectPath = "/work/cake";

function renderProjectSettings(client: TestClientOverrides, settings = defaultProjectSettings()) {
  const rootFixture = createRendererStoreFixture({
    client,
    projects: [projectRecord({ path: projectPath, name: "Cake", settings })],
  });
  const store = rootFixture.root.projectSettingsStore;
  store.open(projectPath);
  const view = render(<ProjectSettingsDialog store={store} />);
  return {
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      rootFixture[Symbol.dispose]();
    },
  };
}

const setProjectSettings = () =>
  vi.fn<Client["workspaces"]["setProjectSettings"]>(async () => defaultApplicationState());

afterEach(cleanup);

describe("Project settings workflow", () => {
  it("loads, edits and clears the browser default URL without resetting it with worktree defaults", async () => {
    let persisted: ProjectSettings = {
      ...defaultProjectSettings(),
      browserDefaultUrl: "http://localhost:5173/",
    };
    const save = vi.fn<Client["workspaces"]["setProjectSettings"]>(async (_path, settings) => {
      persisted = settings;
      return defaultApplicationState();
    });
    {
      using fixture = renderProjectSettings(
        { workspaces: { setProjectSettings: save } },
        persisted,
      );
      const input = screen.getByRole("textbox", { name: "Browser default URL" });
      expect(input).toHaveProperty("value", "http://localhost:5173/");
      await fixture.user.clear(input);
      await fixture.user.type(input, "  https://example.com/start  ");
      await fixture.user.click(screen.getByRole("button", { name: "Restore worktree defaults" }));
      expect(input).toHaveProperty("value", "  https://example.com/start  ");
      await fixture.user.click(screen.getByRole("button", { name: "Save settings" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(persisted.browserDefaultUrl).toBe("https://example.com/start");
    }
    {
      using fixture = renderProjectSettings(
        { workspaces: { setProjectSettings: save } },
        persisted,
      );
      const input = screen.getByRole("textbox", { name: "Browser default URL" });
      expect(input).toHaveProperty("value", "https://example.com/start");
      await fixture.user.clear(input);
      expect(input).toHaveProperty("placeholder", "https://www.google.com/");
      await fixture.user.click(screen.getByRole("button", { name: "Save settings" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(persisted.browserDefaultUrl).toBe("");
    }
  });

  it("saves edited Project Session instructions and closes the dialog", async () => {
    const save = setProjectSettings();
    using fixture = renderProjectSettings({ workspaces: { setProjectSettings: save } });

    const instructions = screen.getByRole("textbox", { name: "Project Session instructions" });
    await fixture.user.clear(instructions);
    await fixture.user.type(instructions, "  Prefer incremental changes.  ");
    await fixture.user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(save).toHaveBeenCalledWith(
      projectPath,
      expect.objectContaining({ customInstructions: "  Prefer incremental changes.  " }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("roundtrips Project Chat instructions separately while preserving exact session guidance and worktree resets", async () => {
    let persisted: ProjectSettings = {
      ...defaultProjectSettings(),
      customInstructions: "  Existing coding guidance.\n",
      projectChatInstructions: "Existing chat guidance.",
    };
    const save = vi.fn<Client["workspaces"]["setProjectSettings"]>(async (path, settings) => {
      expect(path).toBe(projectPath);
      persisted = settings;
      return {
        ...defaultApplicationState(),
        projects: [projectRecord({ path, settings })],
      };
    });
    {
      using fixture = renderProjectSettings(
        { workspaces: { setProjectSettings: save } },
        persisted,
      );
      const chat = screen.getByRole("textbox", { name: "Project Chat instructions" });
      const coding = screen.getByRole("textbox", { name: "Project Session instructions" });
      expect(chat).toHaveProperty("value", "Existing chat guidance.");
      expect(coding).toHaveProperty("value", "  Existing coding guidance.\n");
      expect(chat.getAttribute("aria-describedby")).toBe("project-chat-instructions-help");
      expect(
        screen.getByText(/Only for this project’s permanent Project Chat/).textContent,
      ).toContain("Never added to coding Project Sessions or global Cake Chat");
      await fixture.user.clear(chat);
      await fixture.user.type(chat, "  Discuss plans first.  ");
      await fixture.user.click(screen.getByRole("button", { name: "Restore worktree defaults" }));
      expect(chat).toHaveProperty("value", "  Discuss plans first.  ");
      await fixture.user.click(screen.getByRole("button", { name: "Save settings" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    {
      using fixture = renderProjectSettings(
        { workspaces: { setProjectSettings: save } },
        persisted,
      );
      expect(screen.getByRole("textbox", { name: "Project Chat instructions" })).toHaveProperty(
        "value",
        "  Discuss plans first.  ",
      );
      expect(screen.getByRole("textbox", { name: "Project Session instructions" })).toHaveProperty(
        "value",
        "  Existing coding guidance.\n",
      );
      await fixture.user.click(screen.getByRole("button", { name: "Cancel" }));
    }
  });

  it("keeps the Project Chat draft visible on save failure and permits retry", async () => {
    const save = setProjectSettings().mockRejectedValueOnce(new Error("Storage unavailable"));
    using fixture = renderProjectSettings({ workspaces: { setProjectSettings: save } });
    const chat = screen.getByRole("textbox", { name: "Project Chat instructions" });
    await fixture.user.type(chat, "Keep this draft.");
    await fixture.user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Storage unavailable");
    expect(chat).toHaveProperty("value", "Keep this draft.");
    await fixture.user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("rejects a non-image selection without replacing the generated icon", async () => {
    const save = setProjectSettings();
    using fixture = renderProjectSettings({
      filesystem: {
        chooseAttachments: async () => [{ kind: "file", name: "icon.svg", path: "/work/icon.svg" }],
      },
      workspaces: { setProjectSettings: save },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Choose icon…" }));
    expect(await screen.findByText("Choose a PNG, JPEG, GIF, or WebP image")).toBeDefined();
    expect(screen.getByText("Generated from the project name")).toBeDefined();
    expect(screen.queryByText("Custom icon")).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[1]).not.toHaveProperty("icon");
  });

  it.each([
    {
      name: "a non-image file",
      selection: [{ kind: "file", name: "icon.svg", path: "/work/icon.svg" }],
      error: "Choose a PNG, JPEG, GIF, or WebP image",
    },
    {
      name: "an unsupported image type",
      selection: [{ kind: "image", name: "icon.svg", mimeType: "image/svg+xml", data: "aWNvbg==" }],
      error: "Choose a PNG, JPEG, GIF, or WebP image",
    },
    {
      name: "an oversized image",
      selection: [
        {
          kind: "image",
          name: "large.png",
          mimeType: "image/png",
          data: "a".repeat(PROJECT_ICON_DATA_MAX_LENGTH + 1),
        },
      ],
      error: "Project icons must be smaller than 750 KB",
    },
  ] satisfies Array<{
    name: string;
    selection: Awaited<ReturnType<Client["filesystem"]["chooseAttachments"]>>;
    error: string;
  }>)(
    "rejects $name without replacing a previously selected icon",
    async ({ selection, error }) => {
      const save = setProjectSettings();
      const chooseAttachments = vi
        .fn<Client["filesystem"]["chooseAttachments"]>()
        .mockResolvedValueOnce([
          { kind: "image", name: "cake.png", mimeType: "image/png", data: "aWNvbg==" },
        ])
        .mockResolvedValueOnce(selection);
      using fixture = renderProjectSettings({
        filesystem: { chooseAttachments },
        workspaces: { setProjectSettings: save },
      });
      await fixture.user.click(screen.getByRole("button", { name: "Choose icon…" }));
      expect(await screen.findByText("Custom icon")).toBeDefined();
      await fixture.user.click(screen.getByRole("button", { name: "Choose icon…" }));
      expect(await screen.findByText(error)).toBeDefined();
      expect(screen.getByText("Custom icon")).toBeDefined();
      expect(save).not.toHaveBeenCalled();
      await fixture.user.click(screen.getByRole("button", { name: "Save settings" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(save).toHaveBeenCalledWith(
        projectPath,
        expect.objectContaining({ icon: { mimeType: "image/png", data: "aWNvbg==" } }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    },
  );

  it("shows a selected custom icon and persists it", async () => {
    const save = setProjectSettings();
    const chooseAttachments = vi.fn<Client["filesystem"]["chooseAttachments"]>(async () => [
      { kind: "image", name: "cake.png", mimeType: "image/png", data: "aWNvbg==" },
    ]);
    using fixture = renderProjectSettings({
      filesystem: { chooseAttachments },
      workspaces: { setProjectSettings: save },
    });

    await fixture.user.click(screen.getByRole("button", { name: "Choose icon…" }));
    expect(await screen.findByText("Custom icon")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(save).toHaveBeenCalledWith(
      projectPath,
      expect.objectContaining({ icon: { mimeType: "image/png", data: "aWNvbg==" } }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
