/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { projectPiSettings } from "../../../src/services/pi/runtime/settings-translation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import type { Client } from "../../../src/renderer/client/Client";
import type { TestClientOverrides } from "./test-client";
import { SettingsPage } from "../../../src/renderer/components/settings-page";
import { SidebarProjectGroup } from "../../../src/renderer/components/sidebar-project-group";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { configurationModel } from "./chat-configuration-workflow-fixture";

afterEach(cleanup);

function failure(message: string) {
  const error = new Error(message);
  error.stack = `${message}\nTechnical details for ${message}`;
  return error;
}

async function renderSettingsErrors(client: TestClientOverrides) {
  const fixture = createRendererStoreFixture({
    client: {
      ...client,
      models: {
        list: async () => [configurationModel({ authenticated: false, authTypes: ["api_key"] })],
        ...client.models,
      },
    },
  });
  fixture.root.settingsStore.applyApplicationState(0, defaultApplicationState());
  await fixture.root.modelCatalogStore.ensureLoaded();
  const view = render(<SettingsPage settings={fixture.root.settingsStore} />);
  return {
    ...fixture,
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

async function expectPairedDetails(
  user: ReturnType<typeof userEvent.setup>,
  page: string,
  error: Error,
) {
  const alert = screen.getByRole("alert", { name: `${page} operation failed` });
  expect(within(alert).getByText(error.message)).toBeDefined();
  await user.click(within(alert).getByRole("button", { name: "Copy full error details" }));
  expect(await navigator.clipboard.readText()).toBe(error.stack);
}

describe("Settings error ownership", () => {
  it("simultaneous failures keep message/details paired, including a failure completed on a hidden page", async () => {
    const experimental = failure("Experiment save failed");
    const provider = failure("Provider sign-in failed");
    const pending = Promise.withResolvers<never>();
    using f = await renderSettingsErrors({
      application: { setExperimentalFeatures: () => pending.promise },
      models: {
        login: async () => {
          throw provider;
        },
      },
    });
    await f.user.click(screen.getByRole("button", { name: /^Experimental/ }));
    await f.user.click(screen.getByRole("switch", { name: "Dynamic workflows" }));
    await f.user.click(screen.getByRole("button", { name: /^Providers/ }));
    await f.user.click(screen.getByRole("button", { name: "Add API key" }));
    await screen.findByText(provider.message);
    await act(async () => pending.reject(experimental));

    await expectPairedDetails(f.user, "Providers", provider);
    expect(screen.queryByText(experimental.message)).toBeNull();
    expect(
      within(screen.getByRole("button", { name: /^Experimental/ })).getByText("Error"),
    ).toBeDefined();
    await f.user.click(screen.getByRole("button", { name: /^Experimental/ }));
    await expectPairedDetails(f.user, "Experimental", experimental);
    expect(screen.queryByText(provider.message)).toBeNull();
  });

  it("page switch selects the matching section and keeps unrelated failures actionable in navigation", async () => {
    const provider = failure("Provider is unavailable");
    using f = await renderSettingsErrors({
      models: {
        login: async () => {
          throw provider;
        },
      },
    });
    await f.user.click(screen.getByRole("button", { name: /^Providers/ }));
    await f.user.click(screen.getByRole("button", { name: "Add API key" }));
    await screen.findByText(provider.message);
    await f.user.click(screen.getByRole("button", { name: /^Appearance/ }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      within(screen.getByRole("button", { name: /^Providers/ })).getByText("Error"),
    ).toBeDefined();
    const option = within(screen.getByRole("combobox", { name: "Settings section" })).getByRole(
      "option",
      { name: "Providers — Error" },
    );
    expect(option).toBeDefined();
    await f.user.click(screen.getByRole("button", { name: /^Providers/ }));
    await expectPairedDetails(f.user, "Providers", provider);
  });

  it("keeps a provider failure on its initiating non-chat page after navigation", async () => {
    const pending = Promise.withResolvers<never>();
    const error = failure("Image provider sign-in failed");
    using f = await renderSettingsErrors({
      models: { login: () => pending.promise },
      nonChatModels: {
        list: async () => [
          {
            type: "image",
            provider: "image-provider",
            providerName: "Image provider",
            id: "image-model",
            name: "Image model",
            input: ["text"],
            authenticated: false,
            available: false,
            authTypes: ["api_key"],
          },
        ],
      },
    });
    await f.user.click(screen.getByRole("button", { name: /^Images/ }));
    await f.user.click(screen.getByRole("button", { name: "Add API key" }));
    await f.user.click(screen.getByRole("button", { name: /^Classifiers/ }));
    await act(async () => pending.reject(error));
    expect(screen.queryByRole("alert")).toBeNull();
    await f.user.click(screen.getByRole("button", { name: /^Images/ }));
    await expectPairedDetails(f.user, "Images", error);
  });

  it("absent details do not borrow another failure's details", async () => {
    using f = await renderSettingsErrors({
      models: {
        login: async () => {
          throw failure("Provider has details");
        },
      },
      workspaces: {
        setGlobalCustomInstructions: async () => {
          throw failure("Instructions could not be saved");
        },
      },
    });
    await f.user.click(screen.getByRole("button", { name: /^Providers/ }));
    await f.user.click(screen.getByRole("button", { name: "Add API key" }));
    await screen.findByText("Provider has details");
    await f.user.click(screen.getByRole("button", { name: /^Instructions & prompts/ }));
    await f.user.type(
      screen.getByRole("textbox", { name: "Global instructions" }),
      "Keep my guidance",
    );
    await f.user.tab();
    const alert = await screen.findByRole("alert", {
      name: "Instructions & prompts operation failed",
    });
    expect(within(alert).getByText("Instructions could not be saved")).toBeDefined();
    expect(within(alert).queryByRole("button", { name: /Copy/ })).toBeNull();
  });

  it("a real global failure remains visible alongside local failures and across page switches until its own retry", async () => {
    const global = failure("Pi settings could not be loaded");
    const get = vi
      .fn<Client["piSettings"]["get"]>()
      .mockRejectedValueOnce(global)
      .mockRejectedValueOnce(global)
      .mockResolvedValueOnce(projectPiSettings(SettingsManager.inMemory({})));
    using f = await renderSettingsErrors({
      piSettings: { get },
      models: {
        login: async () => {
          throw failure("Sign-in failed locally");
        },
      },
    });
    // The real renderer bootstrap hydrates this shared dependency.
    await act(async () => f.root.settingsStore.providers.hydrate());
    await f.user.click(screen.getByRole("button", { name: /^Providers/ }));
    await f.user.click(screen.getByRole("button", { name: "Add API key" }));
    expect(await screen.findByText("Sign-in failed locally")).toBeDefined();
    expect(
      within(screen.getByRole("alert", { name: "Settings unavailable" })).getByText(global.message),
    ).toBeDefined();
    await f.user.click(screen.getByRole("button", { name: /^Appearance/ }));
    expect(screen.queryByText("Sign-in failed locally")).toBeNull();
    const banner = screen.getByRole("alert", { name: "Settings unavailable" });
    await f.user.click(within(banner).getByRole("button", { name: "Copy full error details" }));
    expect(await navigator.clipboard.readText()).toBe(global.stack);
    await f.user.click(screen.getByRole("button", { name: "Retry loading settings" }));
    expect(await screen.findByText(global.message)).toBeDefined();
    expect(get).toHaveBeenCalledTimes(2);
    await f.user.click(screen.getByRole("button", { name: "Retry loading settings" }));
    await waitFor(() =>
      expect(screen.queryByRole("alert", { name: "Settings unavailable" })).toBeNull(),
    );
    expect(get).toHaveBeenCalledTimes(3);
    await f.user.click(screen.getByRole("button", { name: /^Providers/ }));
    expect(screen.getByText("Sign-in failed locally")).toBeDefined();
  });

  it("clear/retry updates the message, details, and section indicator consistently", async () => {
    const first = failure("First failure");
    const second = failure("Retry failure");
    const retry = Promise.withResolvers<never>();
    const save = vi
      .fn<Client["application"]["setExperimentalFeatures"]>()
      .mockRejectedValueOnce(first)
      .mockImplementationOnce(() => retry.promise)
      .mockResolvedValueOnce(defaultApplicationState());
    using f = await renderSettingsErrors({ application: { setExperimentalFeatures: save } });
    await f.user.click(screen.getByRole("button", { name: /^Experimental/ }));
    await f.user.click(screen.getByRole("switch", { name: "Dynamic workflows" }));
    await screen.findByText(first.message);
    await expectPairedDetails(f.user, "Experimental", first);
    await f.user.click(screen.getByRole("switch", { name: "Dynamic workflows" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      within(screen.getByRole("button", { name: /^Experimental/ })).queryByText("Error"),
    ).toBeNull();
    await act(async () => retry.reject(second));
    await expectPairedDetails(f.user, "Experimental", second);
    await f.user.click(screen.getByRole("switch", { name: "Dynamic workflows" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      within(screen.getByRole("button", { name: /^Experimental/ })).queryByText("Error"),
    ).toBeNull();
  });

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
    await root.modelCatalogStore.ensureLoaded();
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
