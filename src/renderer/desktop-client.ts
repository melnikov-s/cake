import type { CakeDesktopBridge, DesktopEvent } from "../ipc/desktop-ipc";

export type AgentState = "starting" | "ready" | "stopped" | "failed";

export type DesktopClientEvent =
  | { type: "agent-state-changed"; state: AgentState }
  | { type: "foundation-text-received"; operationId: string; text: string }
  | {
      type: "extension-confirmation-requested";
      operationId: string;
      confirmationId: string;
      title: string;
      message: string;
    }
  | { type: "foundation-check-completed"; operationId: string }
  | { type: "foundation-check-failed"; operationId?: string; message: string };

export interface DesktopClient {
  startFoundationCheck(input: { operationId: string }): Promise<void>;
  respondToExtensionConfirmation(input: {
    operationId: string;
    confirmationId: string;
    accepted: boolean;
  }): Promise<void>;
  subscribe(listener: (event: DesktopClientEvent) => void): () => void;
}

function toClientEvent(event: DesktopEvent): DesktopClientEvent {
  if (event.type === "agent-state") {
    return { type: "agent-state-changed", state: event.state };
  }
  if (event.type === "text-delta") {
    return {
      type: "foundation-text-received",
      operationId: event.requestId,
      text: event.text
    };
  }
  if (event.type === "ui-request") {
    return {
      type: "extension-confirmation-requested",
      operationId: event.requestId,
      confirmationId: event.uiRequestId,
      title: event.title,
      message: event.message
    };
  }
  if (event.type === "complete") {
    return { type: "foundation-check-completed", operationId: event.requestId };
  }
  return {
    type: "foundation-check-failed",
    operationId: event.requestId,
    message: event.message
  };
}

export function createDesktopClient(bridge: CakeDesktopBridge): DesktopClient {
  return {
    async startFoundationCheck({ operationId }) {
      const response = await bridge.request({
        type: "start-foundation-check",
        requestId: operationId
      });
      if (response.type !== "started" || response.requestId !== operationId) {
        throw new Error("Cake received a mismatched foundation-check response");
      }
    },

    async respondToExtensionConfirmation({ operationId, confirmationId, accepted }) {
      const response = await bridge.request({
        type: "respond-ui",
        requestId: operationId,
        uiRequestId: confirmationId,
        accepted
      });
      if (response.type !== "ui-response-accepted" || response.uiRequestId !== confirmationId) {
        throw new Error("Cake received a mismatched extension UI response");
      }
    },

    subscribe(listener) {
      return bridge.subscribe((event) => listener(toClientEvent(event)));
    }
  };
}
