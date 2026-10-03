/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { toSnapshot, type StoreSnapshot } from "r-state-tree";
import { SettingsAppearanceSection } from "../../../src/renderer/components/settings-appearance-section";
import { SidebarProjectGroup } from "../../../src/renderer/components/sidebar-project-group";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function renderAppearanceSettings(snapshot?: StoreSnapshot) {
  const projectPath = "/cake";
  const rootFixture = createRendererStoreFixture({
    projects: [projectRecord({ path: projectPath, name: "Cake" })],
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
  it("defaults to squares, switches both sidebar icon kinds, and restores the saved character preference", async () => {
    let saved: StoreSnapshot;
    {
      using fixture = renderAppearanceSettings();
      const toggle = screen.getByRole("switch", { name: "Show sidebar characters" });
      const variants = () =>
        Array.from(fixture.container.querySelectorAll('[data-slot="avatar"]'), (avatar) =>
          avatar.getAttribute("data-variant"),
        );
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(variants()).toEqual(["square", "square"]);
      await fixture.user.click(toggle);
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      expect(variants()).toEqual(["artwork", "artwork"]);
      expect(fixture.container.querySelector('[data-slot="session-character"]')).not.toBeNull();
      await fixture.user.click(toggle);
      expect(variants()).toEqual(["square", "square"]);
      await fixture.user.click(toggle);
      saved = fixture.savedSnapshot();
    }
    using restored = renderAppearanceSettings(saved);
    expect(
      screen.getByRole("switch", { name: "Show sidebar characters" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(restored.container.querySelectorAll('[data-variant="artwork"]')).toHaveLength(2);
    await restored.user.click(screen.getByRole("switch", { name: "Show sidebar characters" }));
    expect(restored.container.querySelectorAll('[data-variant="square"]')).toHaveLength(2);
  });

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
