/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toSnapshot, type StoreSnapshot } from "r-state-tree";
import { observer } from "r-state-tree/react";
import { useAppDocument } from "../../../src/renderer/hooks/use-app-document";
import type { RootStore } from "../../../src/renderer/stores/RootStore";

const DocumentTheme = observer(function DocumentTheme({ root }: { root: RootStore }) {
  useAppDocument(root);
  return null;
});

function themeFile(content: string, name = "ocean.json") {
  const file = new File([content], name, { type: "application/json" });
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Appearance settings workflow", () => {
  it("saves and restores work-log view and expansion choices in the existing window snapshot", async () => {
    let saved: StoreSnapshot;
    {
      using fixture = renderAppearanceSettings();
      await fixture.user.click(screen.getByRole("button", { name: "Diff view mode" }));
      await fixture.user.click(screen.getByRole("button", { name: "Compact work logs" }));
      saved = fixture.savedSnapshot();
    }
    using restored = renderAppearanceSettings(saved);
    expect(
      screen.getByRole("button", { name: "Diff view mode" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "Compact work logs" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await restored.user.click(screen.getByRole("button", { name: "Auto view mode" }));
    await restored.user.click(screen.getByRole("button", { name: "Collapsed work logs" }));
    expect(
      screen.getByRole("button", { name: "Auto view mode" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "Collapsed work logs" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

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

  it("immediately saves and restores imported color data through the window snapshot", async () => {
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
      await fixture.user.upload(screen.getByLabelText("Import VS Code theme"), themeFile(theme));
      expect(await screen.findByRole("button", { name: "Ocean theme" })).toBeTruthy();
      expect(document.documentElement.style.getPropertyValue("--background")).toBe("#102030");
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
    await restored.user.click(screen.getByRole("button", { name: "Remove dark theme" }));
    expect(
      screen.getByRole("button", { name: "Cake Dark theme" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
  });

  it("saves JSONC source entries with sibling includes without duplicating them on reselection", async () => {
    using fixture = renderAppearanceSettings();
    await fixture.user.click(screen.getByRole("button", { name: "Dark" }));
    await fixture.user.upload(screen.getByLabelText("Import VS Code theme"), [
      themeFile(
        '// Theme data\n{"name":"Paper","type":"light","include":"./base.json"}',
        "paper.jsonc",
      ),
      themeFile('{"name":"Ocean","type":"dark","include":"./base.json"}', "ocean.json"),
      themeFile('{"colors":{"editor.background":"#102030"}}', "base.json"),
    ]);
    expect(await screen.findByRole("button", { name: "Paper theme" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "This theme will apply when Light mode is active.",
    );
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
    const source = screen.getByRole("combobox", { name: "Theme source" });
    await fixture.user.selectOptions(source, "ocean.json");
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#102030");
    await fixture.user.selectOptions(source, "paper.jsonc");
    expect(screen.getAllByRole("button", { name: "Paper theme" })).toHaveLength(1);
    expect(document.documentElement.dataset.theme).toBe("dark");
    await fixture.user.selectOptions(source, "ocean.json");
    expect(screen.getAllByRole("button", { name: "Ocean theme" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Ocean theme" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("shows invalid import errors and leaves the current preference intact", async () => {
    using fixture = renderAppearanceSettings();
    await fixture.user.click(screen.getByRole("button", { name: "Light" }));
    await fixture.user.upload(screen.getByLabelText("Import VS Code theme"), themeFile("{"));
    expect((await screen.findByRole("alert")).textContent).toContain("Invalid JSON");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(screen.getByRole("button", { name: "Light" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("immediately saves independent light/dark choices and restores the explicit appearance mode", async () => {
    let saved: StoreSnapshot;
    {
      using fixture = renderAppearanceSettings();
      await fixture.user.click(screen.getByRole("button", { name: "Light" }));
      await fixture.user.click(screen.getByRole("button", { name: "Solarized Light theme" }));
      expect(document.documentElement.style.getPropertyValue("--background")).toBe("#FDF6E3");
      await fixture.user.click(screen.getByRole("button", { name: "Dark" }));
      await fixture.user.click(screen.getByRole("button", { name: "Warm Titanium theme" }));
      expect(document.documentElement.style.getPropertyValue("--background")).toBe("#242321");
      saved = fixture.savedSnapshot();
    }
    using restored = renderAppearanceSettings(saved);
    expect(screen.getByRole("button", { name: "Dark" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#242321");
    expect(
      screen.getByRole("button", { name: "Warm Titanium theme" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await restored.user.click(screen.getByRole("button", { name: "Light" }));
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#FDF6E3");
    expect(
      screen.getByRole("button", { name: "Solarized Light theme" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it.each(["light", "dark"] as const)(
    "saves the inactive slot without changing explicit %s appearance",
    async (activeMode) => {
      using fixture = renderAppearanceSettings();
      const label = activeMode === "light" ? "Light" : "Dark";
      const inactiveLabel = activeMode === "light" ? "Dark" : "Light";
      const choice = activeMode === "light" ? "Twilight Steel" : "Solarized Light";
      const background = activeMode === "light" ? "#1c2430" : "#FDF6E3";
      await fixture.user.click(screen.getByRole("button", { name: label }));
      const gallery = screen.getByRole("button", { name: `${inactiveLabel} theme` });
      await fixture.user.click(gallery);
      expect(gallery.getAttribute("aria-expanded")).toBe("true");
      await fixture.user.click(gallery);
      expect(gallery.getAttribute("aria-expanded")).toBe("false");
      await fixture.user.click(gallery);
      await fixture.user.click(screen.getByRole("button", { name: `${choice} theme` }));
      expect(screen.getByRole("status").textContent).toBe(
        `This theme will apply when ${inactiveLabel} mode is active.`,
      );
      expect(screen.getByText(`Saved: ${choice}`)).toBeTruthy();
      expect(screen.getByText(`Saved: Cake ${label} · Active`)).toBeTruthy();
      expect(
        screen.getByRole("button", { name: `${choice} theme` }).getAttribute("aria-pressed"),
      ).toBe("true");
      expect(document.documentElement.dataset.theme).toBe(activeMode);
      expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
      expect(screen.getByRole("button", { name: label }).getAttribute("aria-pressed")).toBe("true");
      await fixture.user.click(screen.getByRole("button", { name: inactiveLabel }));
      expect(document.documentElement.style.getPropertyValue("--background")).toBe(background);
      expect(screen.queryByRole("status")).toBeNull();
    },
  );

  it("defaults to System, saves the inactive slot, and follows live OS changes after restoration", async () => {
    let dark = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return dark;
      },
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    }));
    const setOS = (scheme: "light" | "dark") =>
      act(() => {
        dark = scheme === "dark";
        for (const listener of listeners) listener();
      });
    let saved: StoreSnapshot;
    {
      using fixture = renderAppearanceSettings();
      expect(screen.getByRole("button", { name: "System" }).getAttribute("aria-pressed")).toBe(
        "true",
      );
      await fixture.user.click(screen.getByRole("button", { name: "Solarized Light theme" }));
      await fixture.user.click(screen.getByRole("button", { name: "Dark theme" }));
      await fixture.user.click(screen.getByRole("button", { name: "Nord theme" }));
      expect(document.documentElement.style.getPropertyValue("--background")).toBe("#FDF6E3");
      expect(screen.getByRole("status").textContent).toBe(
        "This theme will apply when Dark mode is active.",
      );
      expect(screen.getByRole("button", { name: "System" }).getAttribute("aria-pressed")).toBe(
        "true",
      );
      setOS("dark");
      expect(document.documentElement.style.getPropertyValue("--background")).toBe("#2e3440");
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.getByText("Saved: Nord · Active")).toBeTruthy();
      await fixture.user.click(screen.getByRole("button", { name: "Light theme" }));
      await fixture.user.click(screen.getByRole("button", { name: "Cake Light theme" }));
      expect(screen.getByRole("status").textContent).toBe(
        "This theme will apply when Light mode is active.",
      );
      expect(document.documentElement.style.getPropertyValue("--background")).toBe("#2e3440");
      saved = fixture.savedSnapshot();
    }
    using restored = renderAppearanceSettings(saved);
    expect(screen.getByRole("button", { name: "System" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#2e3440");
    setOS("light");
    expect(document.documentElement.dataset.theme).toBe("system");
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
    await restored.user.click(screen.getByRole("button", { name: "Dark" }));
    setOS("dark");
    setOS("light");
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#2e3440");
  });

  it("imports an inactive theme without switching mode and can select saved imports again without duplication", async () => {
    using fixture = renderAppearanceSettings();
    await fixture.user.click(screen.getByRole("button", { name: "Light" }));
    const picker = screen.getByLabelText("Import VS Code theme");
    await fixture.user.upload(
      picker,
      themeFile(
        JSON.stringify({
          name: "Ocean",
          type: "dark",
          colors: { "editor.background": "#102030" },
        }),
      ),
    );
    expect(await screen.findByRole("button", { name: "Ocean theme" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "This theme will apply when Dark mode is active.",
    );
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
    expect(screen.getByRole("button", { name: "Light" }).getAttribute("aria-pressed")).toBe("true");
    await fixture.user.click(screen.getByRole("button", { name: "Dark" }));
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#102030");
    await fixture.user.click(screen.getByRole("button", { name: "Cake Dark theme" }));
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
    await fixture.user.click(screen.getByRole("button", { name: "Ocean theme" }));
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#102030");
    expect(screen.getAllByRole("button", { name: "Ocean theme" })).toHaveLength(1);
  });
});
