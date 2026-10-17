/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreProvider } from "r-state-tree/react";
import type { CakeEvent } from "../../../src/contracts/application/cake-rpc-contract";
import { App } from "../../../src/renderer/components/app";
import { toStoreEvent } from "../../../src/renderer/events/StoreEvent";
import type {
  ModelOption,
  PiSettings,
} from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { SettingsPage } from "../../../src/renderer/components/settings-page";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

const model = (overrides: Partial<ModelOption> = {}): ModelOption => ({
  provider: "anthropic",
  providerName: "Anthropic",
  id: "claude-sonnet",
  name: "Claude Sonnet",
  reasoning: true,
  availableThinkingLevels: ["off", "high"],
  fastMode: false,
  input: ["text"],
  authenticated: false,
  available: true,
  authTypes: ["api_key"],
  ...overrides,
});

const piSettings: PiSettings = {
  autoCompact: true,
  autoResizeImages: true,
  blockImages: false,
  enableSkillCommands: true,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  transport: "auto",
  httpIdleTimeoutMs: 300000,
  hideThinkingBlock: false,
  mermaidRenderingMode: "final",
  showCacheMissNotices: false,
  collapseChangelog: false,
  quietStartup: false,
  enableInstallTelemetry: false,
  defaultProjectTrust: "ask",
  doubleEscapeAction: "tree",
  treeFilterMode: "default",
  anthropicExtraUsageWarning: true,
  retryEnabled: true,
  defaultTools: null,
  codemodeInlineBudget: 3000,
  shellPath: "",
  shellCommandPrefix: "",
  npmCommand: ["npm"],
  packages: [],
  extensions: [],
  skills: [],
  prompts: [],
  reloadPending: false,
};

async function renderProviderSettings(
  client: TestClientOverrides = {},
  surface: "page" | "app" = "page",
) {
  const rootFixture = createRendererStoreFixture({
    client: {
      ...client,
      models: { list: async () => [model()], ...client.models },
      piSettings: { get: async () => piSettings, ...client.piSettings },
    },
  });
  // Renderer bootstrap hydrates providers even when no chat is active.
  await rootFixture.root.settingsStore.providers.hydrate();
  rootFixture.root.settingsStore.selectPage("providers");
  if (surface === "app") rootFixture.root.navigationStore.showSettings();
  const view = render(
    surface === "app" ? (
      <StoreProvider store={rootFixture.root}>
        <App />
      </StoreProvider>
    ) : (
      <SettingsPage settings={rootFixture.root.settingsStore} />
    ),
  );
  return {
    user: userEvent.setup(),
    async publish(event: CakeEvent) {
      // Same typed service-event delivery as renderer bootstrap. Stores and
      // dialog scoping remain real; transport delivery is covered separately.
      await act(async () => {
        if (event.type === "provider-auth-notice")
          rootFixture.root.settingsStore.providers.receiveAuthNotice(event);
        else {
          const translated = toStoreEvent(event);
          if (!translated) throw new Error(`Unsupported provider event: ${event.type}`);
          rootFixture.root.extensionUiStore.receive(translated);
        }
      });
    },
    [Symbol.dispose]() {
      view.unmount();
      rootFixture[Symbol.dispose]();
    },
  };
}

function providerCard(name: string) {
  const card = screen.getByText(name, { exact: true }).closest("article");
  if (!card) throw new Error(`Missing provider card: ${name}`);
  return within(card);
}

beforeEach(() => {
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
});

describe("Provider settings workflow without an active chat", () => {
  it("presents a device-code challenge during sign-in and opens only safe authentication URLs on this device", async () => {
    let finishLogin!: () => void;
    const loginGate = new Promise<void>((resolve) => {
      finishLogin = resolve;
    });
    const login = vi.fn<Client["models"]["login"]>(() => loginGate);
    const openExternalUrl = vi.fn<Client["electron"]["openExternalUrl"]>(async () => undefined);
    using fixture = await renderProviderSettings({
      models: {
        list: async () => [
          model({
            provider: "xai",
            providerName: "xAI",
            id: "grok",
            name: "Grok",
            authTypes: ["oauth"],
          }),
        ],
        login,
      },
      electron: { openExternalUrl },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Connect" }));
    expect(login).toHaveBeenCalledWith(
      { provider: "xai", authType: "oauth" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.publish({
      type: "provider-auth-notice",
      provider: "xai",
      notice: {
        type: "device_code",
        verificationUri: "https://auth.example/device",
        userCode: "1234-ABCD",
      },
    });
    expect(providerCard("xAI").getByText("1234-ABCD")).toBeDefined();
    expect(providerCard("xAI").getByText("https://auth.example/device")).toBeDefined();
    await fixture.user.click(
      screen.getByRole("button", { name: "Open verification page on this device" }),
    );
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://auth.example/device",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.publish({
      type: "provider-auth-notice",
      provider: "xai",
      notice: { type: "auth_url", url: "http://localhost:1455/auth/callback?code=private" },
    });
    await fixture.user.click(
      screen.getByRole("button", { name: "Open sign-in page on this device" }),
    );
    expect(await screen.findByText(/This callback belongs to the server/)).toBeDefined();
    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    await fixture.publish({
      type: "provider-auth-notice",
      provider: "xai",
      notice: { type: "auth_url", url: "javascript:alert('bad')" },
    });
    await fixture.user.click(
      screen.getByRole("button", { name: "Open sign-in page on this device" }),
    );
    expect(await screen.findByText("Invalid authentication URL")).toBeDefined();
    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    await act(async () => finishLogin());
    await screen.findByRole("button", { name: "Connect" });
  });

  it.each([
    { sessionId: "provider-settings:11:unique", provider: "xai", visible: true },
    { sessionId: "provider-settings:22:unique", provider: "other", visible: false },
    { sessionId: "session-123", provider: "xai", visible: false },
  ])(
    "scopes a provider challenge to its authentication dialog ($sessionId / $provider)",
    async ({ sessionId, provider, visible }) => {
      const respondToUi = vi.fn<Client["artifacts"]["respondToUi"]>(async () => undefined);
      using fixture = await renderProviderSettings({ artifacts: { respondToUi } }, "app");
      await fixture.publish({
        type: "provider-auth-notice",
        provider: "xai",
        notice: {
          type: "device_code",
          verificationUri: "https://auth.example/device",
          userCode: "1234-ABCD",
        },
      });
      const title = `Provider authentication · ${provider}`;
      await fixture.publish({
        type: "ui-request",
        requestId: "auth-request",
        uiRequestId: "auth-dialog",
        sessionId,
        kind: "text",
        title,
        message: "Paste the resulting code",
      });
      const dialog = screen.getByRole("alertdialog", { name: title });
      expect(Boolean(within(dialog).queryByText("1234-ABCD"))).toBe(visible);
      expect(
        Boolean(
          within(dialog).queryByRole("button", { name: "Open verification page on this device" }),
        ),
      ).toBe(visible);
      await fixture.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(respondToUi).toHaveBeenCalledWith({
        operationId: "auth-request",
        uiRequestId: "auth-dialog",
        sessionId,
        value: undefined,
        cancelled: true,
      });
    },
  );
  it("groups models by provider and shows newly available providers after refreshing", async () => {
    const catalog = [model(), model({ id: "claude-opus", name: "Claude Opus" })];
    const refresh = vi.fn<Client["models"]["refresh"]>(async () => {
      catalog.push(
        model({ provider: "openai", providerName: "OpenAI", id: "gpt-5", name: "GPT-5" }),
      );
    });
    using fixture = await renderProviderSettings({
      models: { list: async () => catalog, refresh },
    });

    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(providerCard("Anthropic").getByText("2 models")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Refresh models" }));

    await screen.findByText("OpenAI", { exact: true });
    expect(providerCard("OpenAI").getByText("1 model")).toBeDefined();
    expect(providerCard("Anthropic").getByText("2 models")).toBeDefined();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each([
    { authType: "api_key" as const, button: "Add API key" },
    { authType: "oauth" as const, button: "Connect" },
  ])(
    "connects using $authType, then disconnects and offers authentication again",
    async ({ authType, button }) => {
      let authenticated = false;
      let finishLogin = () => {};
      const loginGate = new Promise<void>((resolve) => {
        finishLogin = resolve;
      });
      const login = vi.fn<Client["models"]["login"]>(async () => {
        await loginGate;
        authenticated = true;
      });
      const logout = vi.fn<Client["models"]["logout"]>(async () => {
        authenticated = false;
      });
      using fixture = await renderProviderSettings({
        models: {
          list: async () => [
            model({
              authenticated,
              authSource: authenticated ? "stored" : undefined,
              authTypes: [authType],
            }),
          ],
          login,
          logout,
        },
      });

      expect(providerCard("Anthropic").getByText("Not connected")).toBeDefined();
      await fixture.user.click(screen.getByRole("button", { name: button }));
      expect(screen.getByRole("button", { name: "Connecting…" })).toHaveProperty("disabled", true);
      expect(login).toHaveBeenCalledWith(
        { provider: "anthropic", authType },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      finishLogin();

      await screen.findByText("Connected", { exact: true });
      await fixture.user.click(screen.getByRole("button", { name: "Disconnect" }));
      await screen.findByRole("button", { name: button });
      expect(providerCard("Anthropic").getByText("Not connected")).toBeDefined();
      expect(logout).toHaveBeenCalledWith(
        { provider: "anthropic" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    },
  );

  it("shows a failed connection and lets the user retry successfully", async () => {
    let authenticated = false;
    const login = vi
      .fn<Client["models"]["login"]>()
      .mockRejectedValueOnce(new Error("The provider rejected this credential"))
      .mockImplementationOnce(async () => {
        authenticated = true;
      });
    using fixture = await renderProviderSettings({
      models: {
        list: async () => [
          model({ authenticated, authSource: authenticated ? "stored" : undefined }),
        ],
        login,
      },
    });

    await fixture.user.click(screen.getByRole("button", { name: "Add API key" }));
    expect(await screen.findByText("The provider rejected this credential")).toBeDefined();
    expect(providerCard("Anthropic").getByText("Not connected")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Add API key" }));
    expect(await screen.findByText("Connected", { exact: true })).toBeDefined();
    expect(login).toHaveBeenCalledTimes(2);
  });

  it("explains how to remove an environment credential instead of offering stored-credential logout", async () => {
    using fixture = await renderProviderSettings({
      models: { list: async () => [model({ authenticated: true, authSource: "environment" })] },
    });
    void fixture; // Keep the disposable UI fixture alive through the assertions.

    expect(providerCard("Anthropic").getByText("Connected · environment")).toBeDefined();
    expect(providerCard("Anthropic").getByText("Remove externally, then restart")).toBeDefined();
    expect(providerCard("Anthropic").queryByRole("button", { name: "Disconnect" })).toBeNull();
  });

  it("saves shell configuration from the runtime page and retains the service result when revisiting", async () => {
    const update = vi.fn<Client["piSettings"]["update"]>(async () => ({
      ...piSettings,
      shellPath: "/bin/fish",
    }));
    using fixture = await renderProviderSettings({ piSettings: { update } });

    await fixture.user.click(screen.getByRole("button", { name: "Execution & resources" }));
    const shell = screen.getByRole("textbox", { name: /^Shell path/ });
    expect(shell).toHaveProperty("value", "");
    await fixture.user.type(shell, "/bin/fish");
    // Clicking another field applies the edited setting through the real blur handler.
    await fixture.user.click(screen.getByRole("textbox", { name: /^Shell command prefix/ }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        { key: "shellPath", value: "/bin/fish" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await fixture.user.click(screen.getByRole("button", { name: /^Providers/ }));
    await fixture.user.click(screen.getByRole("button", { name: "Execution & resources" }));
    expect(screen.getByRole("textbox", { name: /^Shell path/ })).toHaveProperty(
      "value",
      "/bin/fish",
    );
  });
});
