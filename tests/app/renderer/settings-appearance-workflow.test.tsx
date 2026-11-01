/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { toSnapshot, type StoreSnapshot } from "r-state-tree";
import { observer } from "r-state-tree/react";
import { useAppDocument } from "../../../src/renderer/hooks/use-app-document";
import type { RootStore } from "../../../src/renderer/stores/RootStore";

const DocumentTheme = observer(function DocumentTheme({ root }: { root: RootStore }) {
  useAppDocument(root);
  return null;
});

function themeFile(content: string) {
  const file = new File([content], "ocean.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => content });
  return file;
}
import { defaultProjectSettings } from "../../../src/contracts/application/application-data";
import { SettingsAppearanceSection } from "../../../src/renderer/components/settings-appearance-section";
import { SidebarProjectGroup } from "../../../src/renderer/components/sidebar-project-group";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function renderAppearanceSettings(snapshot?: StoreSnapshot, customIcon = false) {
  const projectPath = "/cake";
  const rootFixture = createRendererStoreFixture({
    projects: [
      projectRecord({
        path: projectPath,
        name: "Cake",
        settings: {
          ...defaultProjectSettings(),
          ...(customIcon ? { icon: { mimeType: "image/png" as const, data: "aWNvbg==" } } : {}),
        },
      }),
    ],
    sessions: [
      sessionSummary({ sessionId: "session-1", title: "Appearance session", projectPath }),
    ],
    ...(snapshot ? { snapshot } : {}),
  });
  const { root } = rootFixture;
  const view = render(
    <>
      <DocumentTheme root={root} />
      <SettingsAppearanceSection appearance={root.settingsStore.appearance} />
      <SidebarProjectGroup
        cakeChat={root.cakeChatCollectionStore}
        onOpenCakeChat={(sessionId) => void root.navigationStore.openCakeChat(sessionId)}
        store={root.sidebarStore}
        sessionList={root.sidebarStore.sessionListStore}
        sessionMetadata={root.sessionMetadataStore}
        projects={root.projectCatalogStore}
        chat={root.projectWorkbenchStore}
        shell={root.appShellStore}
        appearance={root.settingsStore.appearance}
        path={projectPath}
        resolved={false}
        onCreateSession={(path) => void root.navigationStore.createSession(path)}
        onOpenSession={(id) => void root.navigationStore.openSession(id)}
        onRemoveProject={(path, deleteSessions) =>
          root.projectRemovalStore.remove(path, deleteSessions)
        }
        onOpenSettings={(path) => root.projectSettingsStore.open(path)}
      />
    </>,
  );
  return {
    user: userEvent.setup(),
    container: view.container,
    savedSnapshot: () => toSnapshot(root),
    [Symbol.dispose]() {
      view.unmount();
      rootFixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

describe("Appearance settings workflow", () => {
  it.each([false, true])(
    "switches only session icons and restores the saved preference (custom project icon: %s)",
    async (customIcon) => {
      let saved: StoreSnapshot;
      let projectImageSource: string | null;
      {
        using fixture = renderAppearanceSettings(undefined, customIcon);
        const toggle = screen.getByRole("switch", { name: "Show session characters" });
        const projectImage = fixture.container.querySelector(
          '[data-slot="project-group"] > div img',
        )!;
        projectImageSource = projectImage.getAttribute("src");
        expect(projectImageSource).toBeTruthy();
        if (customIcon) expect(projectImageSource).toBe("data:image/png;base64,aWNvbg==");
        const variants = () =>
          Array.from(fixture.container.querySelectorAll('[data-slot="avatar"]'), (avatar) =>
            avatar.getAttribute("data-variant"),
          );
        expect(toggle.getAttribute("aria-checked")).toBe("false");
        expect(variants()).toEqual(["artwork", "square"]);
        await fixture.user.click(toggle);
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        expect(variants()).toEqual(["artwork", "artwork"]);
        expect(projectImage.getAttribute("src")).toBe(projectImageSource);
        expect(fixture.container.querySelector('[data-slot="session-character"]')).not.toBeNull();
        await fixture.user.click(toggle);
        expect(variants()).toEqual(["artwork", "square"]);
        expect(projectImage.getAttribute("src")).toBe(projectImageSource);
        await fixture.user.click(toggle);
        saved = fixture.savedSnapshot();
      }
      using restored = renderAppearanceSettings(saved, customIcon);
      expect(
        screen
          .getByRole("switch", { name: "Show session characters" })
          .getAttribute("aria-checked"),
      ).toBe("true");
      expect(restored.container.querySelectorAll('[data-variant="artwork"]')).toHaveLength(2);
      expect(
        restored.container
          .querySelector('[data-slot="project-group"] > div img')
          ?.getAttribute("src"),
      ).toBe(projectImageSource);
      await restored.user.click(screen.getByRole("switch", { name: "Show session characters" }));
      expect(restored.container.querySelectorAll('[data-variant="square"]')).toHaveLength(1);
    },
  );

  it("lets users independently disable and re-enable project and session avatars", async () => {
    using fixture = renderAppearanceSettings();
    const projects = screen.getByRole("switch", { name: "Project avatars" });
    const sessions = screen.getByRole("switch", { name: "Session avatars" });

    expect(projects.getAttribute("aria-checked")).toBe("true");
    expect(sessions.getAttribute("aria-checked")).toBe("true");

    await fixture.user.click(projects);
    expect(projects.getAttribute("aria-checked")).toBe("false");
    expect(sessions.getAttribute("aria-checked")).toBe("true");

    await fixture.user.click(sessions);
    expect(projects.getAttribute("aria-checked")).toBe("false");
    expect(sessions.getAttribute("aria-checked")).toBe("false");

    await fixture.user.click(projects);
    expect(projects.getAttribute("aria-checked")).toBe("true");
    expect(sessions.getAttribute("aria-checked")).toBe("false");

    await fixture.user.click(sessions);
    expect(projects.getAttribute("aria-checked")).toBe("true");
    expect(sessions.getAttribute("aria-checked")).toBe("true");
  });

  it("previews, cancels, applies and restores imported color data through the window snapshot", async () => {
    let saved: StoreSnapshot;
    const theme = JSON.stringify({
      name: "Ocean",
      type: "dark",
      colors: { "editor.background": "#102030", "editor.foreground": "#eeeeee" },
      tokenColors: [{ scope: "keyword", settings: { foreground: "#ffaa00" } }],
    });
    {
      using fixture = renderAppearanceSettings();
      await fixture.user.click(screen.getByRole("button", { name: "Dark" }));
      const picker = screen.getByLabelText("Import VS Code theme");
      await fixture.user.upload(picker, themeFile(theme));
      expect(await screen.findByText("Preview: Ocean")).toBeTruthy();
      expect(document.documentElement.style.getPropertyValue("--background")).toBe("#102030");
      await fixture.user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
      await fixture.user.upload(picker, themeFile(theme));
      await fixture.user.click(await screen.findByRole("button", { name: "Apply theme" }));
      expect(screen.getByRole("button", { name: "Ocean theme" }).getAttribute("aria-pressed")).toBe(
        "true",
      );
      saved = fixture.savedSnapshot();
      await fixture.user.click(screen.getByRole("button", { name: "Light" }));
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
    }
    using restored = renderAppearanceSettings(saved);
    expect(screen.getByRole("button", { name: "Ocean theme" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#102030");
    await restored.user.click(screen.getByRole("button", { name: "Remove theme" }));
    expect(
      screen.getByRole("button", { name: "Cake Dark theme" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
  });

  it("shows invalid import errors and leaves the current preference intact", async () => {
    using fixture = renderAppearanceSettings();
    await fixture.user.click(screen.getByRole("button", { name: "Light" }));
    await fixture.user.upload(screen.getByLabelText("Import VS Code theme"), themeFile("{"));
    expect((await screen.findByRole("alert")).textContent).toContain("Invalid JSON");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(screen.getByRole("button", { name: "Apply theme" }).hasAttribute("disabled")).toBe(true);
  });

  it("saves independent light/dark favorites, cancels previews and restores only applied choices", async () => {
    let previewSnapshot: StoreSnapshot;
    let appliedSnapshot: StoreSnapshot;
    {
      using fixture = renderAppearanceSettings();
      await fixture.user.click(screen.getByRole("button", { name: "Light" }));
      await fixture.user.click(screen.getByRole("button", { name: "Solarized Light theme" }));
      expect(document.documentElement.style.getPropertyValue("--background")).toBe("#FDF6E3");
      await fixture.user.click(screen.getByRole("button", { name: "Apply theme" }));
      await fixture.user.click(screen.getByRole("button", { name: "Dark" }));
      await fixture.user.click(screen.getByRole("button", { name: "Warm Titanium theme" }));
      expect(document.documentElement.style.getPropertyValue("--background")).toBe("#242321");
      await fixture.user.click(screen.getByRole("button", { name: "Apply theme" }));
      appliedSnapshot = fixture.savedSnapshot();
      await fixture.user.click(screen.getByRole("button", { name: "Nord theme" }));
      expect(screen.getByRole("status").textContent).toBe("Preview: Nord");
      previewSnapshot = fixture.savedSnapshot();
      await fixture.user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(document.documentElement.style.getPropertyValue("--background")).toBe("#242321");
      await fixture.user.click(screen.getByRole("button", { name: "Light" }));
      expect(document.documentElement.style.getPropertyValue("--background")).toBe("#FDF6E3");
      expect(
        screen.getByRole("button", { name: "Solarized Light theme" }).getAttribute("aria-pressed"),
      ).toBe("true");
      await fixture.user.click(screen.getByRole("button", { name: "Follow System" }));
      expect(document.documentElement.style.getPropertyValue("--background")).toBe("#FDF6E3");
    }
    for (const saved of [appliedSnapshot, previewSnapshot]) {
      using restored = renderAppearanceSettings(saved);
      expect(document.documentElement.style.getPropertyValue("--background")).toBe("#242321");
      expect(
        screen.getByRole("button", { name: "Warm Titanium theme" }).getAttribute("aria-pressed"),
      ).toBe("true");
      await restored.user.click(screen.getByRole("button", { name: "Light" }));
      expect(
        screen.getByRole("button", { name: "Solarized Light theme" }).getAttribute("aria-pressed"),
      ).toBe("true");
    }
  });

  it("can edit the inactive mode's favorite without changing appearance mode", async () => {
    using fixture = renderAppearanceSettings();
    await fixture.user.click(screen.getByRole("button", { name: "Light" }));
    const gallery = screen.getByRole("button", { name: "Dark theme" });
    await fixture.user.click(gallery);
    expect(gallery.getAttribute("aria-expanded")).toBe("true");
    await fixture.user.click(gallery);
    expect(gallery.getAttribute("aria-expanded")).toBe("false");
    await fixture.user.click(gallery);
    await fixture.user.click(screen.getByRole("button", { name: "Twilight Steel theme" }));
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#1c2430");
    await fixture.user.click(screen.getByRole("button", { name: "Apply theme" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
    expect(screen.getByRole("button", { name: "Light" }).getAttribute("aria-pressed")).toBe("true");
    await fixture.user.click(screen.getByRole("button", { name: "Dark" }));
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#1c2430");
  });

  it("compares saved imports by mode and applies one again without duplicating it", async () => {
    using fixture = renderAppearanceSettings();
    const picker = screen.getByLabelText("Import VS Code theme");
    for (const [name, type, background] of [
      ["Ocean", "dark", "#102030"],
      ["Paper", "light", "#fff8e8"],
    ] as const) {
      await fixture.user.click(
        screen.getByRole("button", { name: type === "light" ? "Light" : "Dark" }),
      );
      await fixture.user.upload(
        picker,
        themeFile(JSON.stringify({ name, type, colors: { "editor.background": background } })),
      );
      await fixture.user.click(await screen.findByRole("button", { name: "Apply theme" }));
    }
    expect(screen.getByRole("button", { name: "Paper theme" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Dark" }));
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#102030");
    await fixture.user.click(screen.getByRole("button", { name: "Cake Dark theme" }));
    await fixture.user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#102030");
    await fixture.user.click(screen.getByRole("button", { name: "Ocean theme" }));
    await fixture.user.click(screen.getByRole("button", { name: "Apply theme" }));
    expect(screen.getAllByRole("button", { name: "Ocean theme" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Ocean theme" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
});
