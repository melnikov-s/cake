import { describe, expect, it, vi } from "vitest";
import type { DesktopClient, DesktopClientEvent } from "./desktop-client";
import { mountWindowStore } from "./window-store";

function createDesktopClient() {
  let listener: ((event: DesktopClientEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const startFoundationCheck = vi.fn(async () => undefined);
  const respondToExtensionConfirmation = vi.fn(async () => undefined);
  const client: DesktopClient = {
    startFoundationCheck,
    respondToExtensionConfirmation,
    subscribe(nextListener) {
      listener = nextListener;
      return unsubscribe;
    }
  };
  return {
    client,
    startFoundationCheck,
    respondToExtensionConfirmation,
    unsubscribe,
    emit: (event: DesktopClientEvent) => listener?.(event)
  };
}

describe("WindowStore", () => {
  it("owns the desktop subscription and ignores stale operation events", async () => {
    const desktop = createDesktopClient();
    const store = mountWindowStore(desktop.client);
    desktop.emit({ type: "agent-state-changed", state: "ready" });
    await store.startFoundationCheck();
    const operationId = store.activeOperationId!;

    desktop.emit({
      type: "foundation-text-received",
      operationId: "00000000-0000-4000-8000-000000000002",
      text: "stale"
    });
    desktop.emit({ type: "foundation-text-received", operationId, text: "current" });

    expect(store.text).toBe("current");
    expect(desktop.startFoundationCheck).toHaveBeenCalledWith({ operationId });
    store[Symbol.dispose]();
    expect(desktop.unsubscribe).toHaveBeenCalledOnce();
  });

  it("routes a correlated Pi extension confirmation response", async () => {
    const desktop = createDesktopClient();
    const store = mountWindowStore(desktop.client);
    desktop.emit({ type: "agent-state-changed", state: "ready" });
    await store.startFoundationCheck();
    const operationId = store.activeOperationId!;
    desktop.emit({
      type: "extension-confirmation-requested",
      operationId,
      confirmationId: "00000000-0000-4000-8000-000000000003",
      title: "Continue?",
      message: "Confirm the bridge"
    });

    await store.respondToConfirmation(true);

    expect(desktop.respondToExtensionConfirmation).toHaveBeenCalledWith({
      operationId,
      confirmationId: "00000000-0000-4000-8000-000000000003",
      accepted: true
    });
    store[Symbol.dispose]();
  });
});
