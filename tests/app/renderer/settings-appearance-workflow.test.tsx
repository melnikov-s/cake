/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { toSnapshot, type StoreSnapshot } from "r-state-tree";
import { defaultProjectSettings } from "../../../src/domain/application/application-data";
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
      <SettingsAppearanceSection appearance={root.settingsStore.appearance} />
      <SidebarProjectGroup
        store={root.sidebarStore}
        sessionList={root.sidebarStore.sessionListStore}
        sessionMetadata={root.sessionMetadataStore}
        projects={root.projectCatalogStore}
        chat={root.projectWorkbenchStore}
        shell={root.appShellStore}
        appearance={root.settingsStore.appearance}
        path={projectPath}
        resolved={false}
        onCreateSession={(path) => void root.createSession(path)}
        onOpenSession={(id) => void root.openSession(id)}
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

  it("lets users choose either fixed theme and return to the system preference", async () => {
    using fixture = renderAppearanceSettings();
    const theme = screen.getByRole("combobox", { name: "Color theme" });
    const selectedTheme = () => screen.getByRole("option", { selected: true }).textContent;

    expect(selectedTheme()).toBe("System");
    await fixture.user.selectOptions(theme, "dark");
    expect(selectedTheme()).toBe("Dark");
    await fixture.user.selectOptions(theme, "light");
    expect(selectedTheme()).toBe("Light");
    await fixture.user.selectOptions(theme, "system");
    expect(selectedTheme()).toBe("System");
  });
});
