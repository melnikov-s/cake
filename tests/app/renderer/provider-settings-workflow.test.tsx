/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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

async function renderProviderSettings(client: TestClientOverrides = {}) {
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
  const view = render(<SettingsPage settings={rootFixture.root.settingsStore} />);
  return {
    user: userEvent.setup(),
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

afterEach(cleanup);

describe("Provider settings workflow without an active chat", () => {
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
