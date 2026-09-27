import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { child, createStore, mount, Store } from "r-state-tree";
import { SettingsProvidersSection } from "../../../src/renderer/components/settings-providers-section";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { ProviderSettingsStore } from "../../../src/renderer/stores/ProviderSettingsStore";
import { SessionOperationCoordinatorStore } from "../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { ClientContext } from "../../../src/renderer/stores/context/ClientContext";

class HarnessStore extends Store<{ client: Client }> {
  [ClientContext.provide]() {
    return this.props.client;
  }
  @child get operations() {
    return createStore(SessionOperationCoordinatorStore);
  }
  @child get providers() {
    return createStore(ProviderSettingsStore, { operations: this.operations });
  }
}

describe("provider authentication on the initiating device", () => {
  it("presents the server's verification URL and device code, and opens only safe URLs locally", async () => {
    const openExternalUrl = vi.fn(async () => undefined);
    const root = mount(
      createStore(HarnessStore, {
        client: { electron: { openExternalUrl } } as unknown as Client,
      }),
    );
    const store = root.providers;
    store.receiveAuthNotice({
      provider: "xai",
      notice: {
        type: "device_code",
        verificationUri: "https://auth.example/device",
        userCode: "1234-ABCD",
      },
    });
    expect(store.authNotices.xai).toMatchObject({ userCode: "1234-ABCD" });
    expect(
      store.authNoticeForRequest({
        sessionId: "provider-settings:11:unique",
        title: "Provider authentication · xai",
      }),
    ).toMatchObject({ userCode: "1234-ABCD" });
    expect(
      store.authNoticeForRequest({
        sessionId: "provider-settings:22:unique",
        title: "Provider authentication · other",
      }),
    ).toBeUndefined();
    expect(
      store.authNoticeForRequest({
        sessionId: "session-123",
        title: "Provider authentication · xai",
      }),
    ).toBeUndefined();
    const markup = renderToStaticMarkup(
      createElement(SettingsProvidersSection, {
        providers: store,
        providerGroups: [
          {
            id: "xai",
            name: "xAI",
            models: [
              {
                provider: "xai",
                providerName: "xAI",
                id: "grok",
                name: "Grok",
                reasoning: true,
                availableThinkingLevels: ["off"],
                fastMode: false,
                input: ["text"],
                authenticated: false,
                available: false,
                authTypes: ["oauth"],
              },
            ],
          },
        ],
      }),
    );
    expect(markup).toContain("1234-ABCD");
    expect(markup).toContain("https://auth.example/device");
    expect(markup).toContain("Open verification page on this device");
    await store.openAuthUrl(store.authNotices.xai?.verificationUri ?? "");
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://auth.example/device",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await store.openAuthUrl("http://localhost:1455/auth/callback?code=private");
    await store.openAuthUrl("javascript:alert('bad')");
    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    root[Symbol.dispose]();
  });
});
