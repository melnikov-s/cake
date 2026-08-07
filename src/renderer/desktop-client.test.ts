import type { CakeDesktopBridge, DesktopEvent, DesktopRequest, DesktopResponse } from "../ipc/desktop-ipc";
import { describe, expect, it, vi } from "vitest";
import { createDesktopClient } from "./desktop-client";

function createBridge() {
  let listener: ((event: DesktopEvent) => void) | undefined;
  const request = vi.fn(async (input: DesktopRequest): Promise<DesktopResponse> => {
    if (input.type === "start-foundation-check") {
      return { type: "started", requestId: input.requestId };
    }
    return { type: "ui-response-accepted", uiRequestId: input.uiRequestId };
  });
  const bridge: CakeDesktopBridge = {
    request,
    subscribe(nextListener) {
      listener = nextListener;
      return () => undefined;
    }
  };
  return { bridge, request, emit: (event: DesktopEvent) => listener?.(event) };
}

describe("desktop client boundary", () => {
  it("translates foundation intent to the preload protocol", async () => {
    const { bridge, request } = createBridge();
    const client = createDesktopClient(bridge);

    await client.startFoundationCheck({ operationId: "00000000-0000-4000-8000-000000000001" });

    expect(request).toHaveBeenCalledWith({
      type: "start-foundation-check",
      requestId: "00000000-0000-4000-8000-000000000001"
    });
  });

  it("translates protocol events to application events", () => {
    const { bridge, emit } = createBridge();
    const client = createDesktopClient(bridge);
    const listener = vi.fn();
    client.subscribe(listener);

    emit({
      type: "ui-request",
      requestId: "00000000-0000-4000-8000-000000000001",
      uiRequestId: "00000000-0000-4000-8000-000000000002",
      kind: "confirm",
      title: "Continue?",
      message: "Confirm the bridge"
    });

    expect(listener).toHaveBeenCalledWith({
      type: "extension-confirmation-requested",
      operationId: "00000000-0000-4000-8000-000000000001",
      confirmationId: "00000000-0000-4000-8000-000000000002",
      title: "Continue?",
      message: "Confirm the bridge"
    });
  });
});
