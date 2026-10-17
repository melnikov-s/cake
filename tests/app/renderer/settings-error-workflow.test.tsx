/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { SettingsPage } from "../../../src/renderer/components/settings-page";
import { SidebarProjectGroup } from "../../../src/renderer/components/sidebar-project-group";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

describe("Settings error ownership", () => {
  it("keeps a failed session open out of Settings while showing settings failures and clearing them on retry", async () => {
    const projectPath = "/cake";
    const sessionId = "missing-session";
    const missingSession = `Cake could not find Project Session ${sessionId}`;
    const open = vi.fn<Client["projectSessions"]["open"]>(async () => {
      throw new Error(missingSession);
    });
    const refresh = vi
      .fn<Client["models"]["refresh"]>()
      .mockRejectedValueOnce(new Error("Could not refresh providers"))
      .mockResolvedValueOnce(undefined);
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: projectPath })],
      sessions: [sessionSummary({ sessionId, projectPath, title: "Missing conversation" })],
      client: {
        projectSessions: { open },
        models: { refresh, list: async () => [] },
      },
    });
    const { root } = fixture;
    root.settingsStore.selectPage("providers");
    const user = userEvent.setup();
    const view = render(
      <>
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
          flattenSessions
          onCreateSession={(path) => void root.navigationStore.createSession(path)}
          onOpenSession={(id) => void root.navigationStore.openSession(id)}
          onRemoveProject={(path, deleteSessions) =>
            root.projectRemovalStore.remove(path, deleteSessions)
          }
          onOpenSettings={(path) => root.projectSettingsStore.open(path)}
        />
        <SettingsPage settings={root.settingsStore} />
      </>,
    );
    try {
      await user.click(screen.getByRole("button", { name: /^Missing conversation/ }));
      await waitFor(() => expect(open).toHaveBeenCalledOnce());
      await waitFor(() => expect(root.projectWorkbenchStore.error).toBe(missingSession));
      expect(screen.queryByText(missingSession)).toBeNull();

      await user.click(screen.getByRole("button", { name: "Refresh models" }));
      expect(await screen.findByText("Could not refresh providers")).toBeDefined();
      expect(screen.queryByText(missingSession)).toBeNull();

      await user.click(screen.getByRole("button", { name: "Refresh models" }));
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByText("Could not refresh providers")).toBeNull());
      expect(screen.queryByText(missingSession)).toBeNull();
    } finally {
      view.unmount();
    }
  });
});
