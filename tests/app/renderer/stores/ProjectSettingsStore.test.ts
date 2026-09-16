import { createStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { defaultProjectSettings } from "../../../../src/domain/application/application-data";
import type { Client } from "../../../../src/renderer/client/Client";
import type { ProjectCatalogStore } from "../../../../src/renderer/stores/ProjectCatalogStore";
import { ProjectSettingsStore } from "../../../../src/renderer/stores/ProjectSettingsStore";
import { mountWithClient } from "../mount-with-client";

function mountSettings(client: Client) {
  const projects = {
    nameForPath: () => "Cake",
    find: () => ({ settings: defaultProjectSettings(), workflow: { labels: [] } }),
  } as unknown as ProjectCatalogStore;
  return mountWithClient(createStore(ProjectSettingsStore, { projects }), client);
}

describe("ProjectSettingsStore", () => {
  it("chooses and persists a custom project icon", async () => {
    const setProjectSettings = vi.fn(async () => ({}));
    const { root, subject } = mountSettings({
      filesystem: {
        chooseAttachments: vi.fn(async () => [
          { kind: "image", name: "cake.png", mimeType: "image/png", data: "aWNvbg==" },
        ]),
      },
      workspaces: { setProjectSettings },
    } as unknown as Client);

    subject.open("/work/cake");
    await subject.chooseIcon();
    expect(subject.icon).toEqual({ mimeType: "image/png", data: "aWNvbg==" });

    await subject.save();
    expect(setProjectSettings).toHaveBeenCalledWith(
      "/work/cake",
      expect.objectContaining({ icon: { mimeType: "image/png", data: "aWNvbg==" } }),
      expect.anything(),
    );
    root[Symbol.dispose]();
  });

  it("rejects a non-image selection and keeps the generated icon", async () => {
    const { root, subject } = mountSettings({
      filesystem: {
        chooseAttachments: vi.fn(async () => [
          { kind: "file", name: "icon.svg", path: "/work/icon.svg" },
        ]),
      },
    } as unknown as Client);

    subject.open("/work/cake");
    await subject.chooseIcon();

    expect(subject.icon).toBeUndefined();
    expect(subject.error).toBe("Choose a PNG, JPEG, GIF, or WebP image");
    root[Symbol.dispose]();
  });
});
