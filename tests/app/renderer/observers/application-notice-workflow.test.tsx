/** @vitest-environment jsdom */
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Queue, Schema, Stream } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import type { applicationEventSchema } from "../../../../src/contracts/application/cake-rpc-contract";
import { piSettingsSchema } from "../../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../../src/renderer/client/Client";
import { SettingsPage } from "../../../../src/renderer/components/settings-page";
import { ToastHost } from "../../../../src/renderer/components/toast-host";
import { observeApplicationEvents } from "../../../../src/renderer/observers/application-events";
import { projectPiSettings } from "../../../../src/services/pi/runtime/settings-translation";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import { observerClient, observerRuntime } from "./observer-test-runtime";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function noticePiAuthority() {
  return Schema.decodeUnknownSync(piSettingsSchema)({
    ...projectPiSettings(
      SettingsManager.fromStorage(
        {
          withLock(_scope, update) {
            update("{}");
          },
        },
        { projectTrusted: true },
      ),
    ),
    hideThinkingBlock: true,
  });
}

it("updates an open settings surface from Pi authority, allows another edit, and dismisses an attributed agent notice", async () => {
  const settings = noticePiAuthority();
  const update = vi.fn<Client["piSettings"]["update"]>(async () => ({
    ...settings,
    hideThinkingBlock: false,
  }));
  using fixture = createRendererStoreFixture({ client: { piSettings: { update } } });
  fixture.root.settingsStore.selectPage("agent");
  const events = Effect.runSync(Queue.unbounded<typeof applicationEventSchema.Type>());
  const runtime = observerRuntime(
    observerClient({ events: { application: () => Stream.fromQueue(events) } }),
  );
  const cancel = observeApplicationEvents(runtime, fixture.root);
  const view = render(
    <>
      <SettingsPage settings={fixture.root.settingsStore} />
      <ToastHost store={fixture.root.toastStore} />
    </>,
  );
  const user = userEvent.setup();
  const emit = async (event: typeof applicationEventSchema.Type) => {
    await act(async () => {
      Queue.offerUnsafe(events, event);
      await Effect.runPromise(Queue.take(runtime.consumed));
    });
  };
  try {
    await emit({ type: "pi-settings-changed", settings });
    const toggle = screen.getByRole("switch", { name: /Hide thinking/ });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(update).toHaveBeenCalledWith(
      { key: "hideThinkingBlock", value: false },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await emit({
      type: "agent-action-notice",
      source: { kind: "project-session", sessionId: "source", title: "Source" },
      message: "Updated Cake Project settings",
      coalesceKey: "project-settings:/project",
    });
    expect(screen.getByRole("status").textContent).toContain("Agent action · Source");
    expect(screen.getByRole("status").textContent).toContain("Updated Cake Project settings");
    await user.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByText("Updated Cake Project settings")).toBeNull();
  } finally {
    view.unmount();
    cancel();
    await runtime.dispose();
  }
});

it("keeps authentication codes in provider settings while session notices and native notifications stay redacted", async () => {
  const showNotification = vi.fn<Client["electron"]["showNotification"]>(async () => undefined);
  const openExternalUrl = vi.fn<Client["electron"]["openExternalUrl"]>(async () => undefined);
  using fixture = createRendererStoreFixture({
    client: {
      electron: { showNotification, openExternalUrl },
      piSettings: { get: async () => noticePiAuthority() },
      models: {
        list: async () => [
          {
            provider: "test-provider",
            providerName: "Test provider",
            id: "test-model",
            name: "Test model",
            reasoning: false,
            availableThinkingLevels: ["off"],
            input: ["text"],
            authenticated: false,
            available: true,
            authTypes: ["oauth"],
          },
        ],
      },
    },
  });
  await fixture.root.settingsStore.providers.hydrate();
  fixture.root.settingsStore.selectPage("providers");
  const events = Effect.runSync(Queue.unbounded<typeof applicationEventSchema.Type>());
  const runtime = observerRuntime(
    observerClient({ events: { application: () => Stream.fromQueue(events) } }),
  );
  const cancel = observeApplicationEvents(runtime, fixture.root);
  const view = render(
    <>
      <SettingsPage settings={fixture.root.settingsStore} />
      <ToastHost store={fixture.root.toastStore} />
    </>,
  );
  const user = userEvent.setup();
  const notice = {
    type: "provider-auth-notice" as const,
    provider: "test-provider",
    notice: {
      type: "device_code" as const,
      verificationUri: "https://auth.example/device",
      userCode: "SECRET-CODE",
    },
  };
  const emit = async (event: typeof applicationEventSchema.Type) => {
    await act(async () => {
      Queue.offerUnsafe(events, event);
      await Effect.runPromise(Queue.take(runtime.consumed));
    });
  };
  try {
    await emit(notice);
    expect(screen.getByText("SECRET-CODE")).toBeDefined();
    expect(screen.queryByRole("status")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open verification page on this device" }));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://auth.example/device",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await emit({ ...notice, sessionId: "session-1" });
    const toast = screen.getByRole("status");
    expect(toast.textContent).toContain(
      "Open Settings → Providers to continue authentication on this device.",
    );
    expect(toast.textContent).not.toContain("SECRET-CODE");
    expect(showNotification).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    cancel();
    await runtime.dispose();
  }
});

it("coalesces ordered notifications into one visible notice and ignores events after cancellation", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const showNotification = vi.fn<Client["electron"]["showNotification"]>(async () => undefined);
  using fixture = createRendererStoreFixture({ client: { electron: { showNotification } } });
  const events = Effect.runSync(Queue.unbounded<typeof applicationEventSchema.Type>());
  const runtime = observerRuntime(
    observerClient({ events: { application: () => Stream.fromQueue(events) } }),
  );
  const cancel = observeApplicationEvents(runtime, fixture.root);
  const view = render(<ToastHost store={fixture.root.toastStore} />);
  const user = userEvent.setup();
  try {
    for (const message of ["Build starting", "Input is required."]) {
      await act(async () => {
        Queue.offerUnsafe(events, {
          type: "notification",
          tone: "warning",
          title: "Build waiting",
          message,
        });
        await Effect.runPromise(Queue.take(runtime.consumed));
      });
    }
    expect(showNotification).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(screen.getByRole("status").textContent).toContain("Input is required.");
    expect(screen.queryByText("Build starting")).toBeNull();
    expect(showNotification).toHaveBeenCalledExactlyOnceWith(
      {
        title: "Build waiting",
        body: "Input is required.",
        level: "warning",
        id: "cake-agent:cake-agent",
        groupId: "cake-agent:cake-agent",
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    vi.useRealTimers();
    await user.click(screen.getByRole("button", { name: "Dismiss notification" }));
    cancel();
    await runtime.dispose();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      Queue.offerUnsafe(events, {
        type: "notification",
        tone: "error",
        title: "Late",
        message: "Must not arrive",
      });
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  } finally {
    view.unmount();
    cancel();
    await runtime.dispose();
  }
});
