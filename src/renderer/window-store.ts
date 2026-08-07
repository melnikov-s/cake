import { Store, createStore, mount } from "r-state-tree";
import type { AgentState, DesktopClient, DesktopClientEvent } from "./desktop-client";

export interface ConfirmRequest {
  operationId: string;
  confirmationId: string;
  title: string;
  message: string;
}

export class WindowStore extends Store<{ client: DesktopClient }> {
  readonly process = "renderer" as const;
  agentState: AgentState = "starting";
  text = "";
  error: string | undefined;
  activeOperationId: string | undefined;
  confirmRequest: ConfirmRequest | undefined;

  constructor(props: WindowStore["props"]) {
    super(props);
    this.effect(() => this.props.client.subscribe((event) => this.receive(event)));
  }

  get isRunning() {
    return this.activeOperationId !== undefined;
  }

  async startFoundationCheck() {
    if (this.isRunning || this.agentState !== "ready") return;
    this.text = "";
    this.error = undefined;
    this.confirmRequest = undefined;
    const operationId = crypto.randomUUID();
    this.activeOperationId = operationId;

    try {
      await this.props.client.startFoundationCheck({ operationId });
    } catch (error) {
      if (this.activeOperationId !== operationId) return;
      this.error = error instanceof Error ? error.message : String(error);
      this.activeOperationId = undefined;
    }
  }

  async respondToConfirmation(accepted: boolean) {
    const confirmation = this.confirmRequest;
    if (!confirmation || confirmation.operationId !== this.activeOperationId) return;
    this.confirmRequest = undefined;

    try {
      await this.props.client.respondToExtensionConfirmation({
        operationId: confirmation.operationId,
        confirmationId: confirmation.confirmationId,
        accepted
      });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private receive(event: DesktopClientEvent) {
    if (event.type === "agent-state-changed") {
      this.agentState = event.state;
      if (event.state === "failed" || event.state === "stopped") {
        this.activeOperationId = undefined;
        this.confirmRequest = undefined;
      }
      return;
    }

    if (event.operationId !== this.activeOperationId) return;

    if (event.type === "foundation-text-received") this.text += event.text;
    if (event.type === "extension-confirmation-requested") {
      this.confirmRequest = {
        operationId: event.operationId,
        confirmationId: event.confirmationId,
        title: event.title,
        message: event.message
      };
    }
    if (event.type === "foundation-check-completed") {
      this.activeOperationId = undefined;
      this.confirmRequest = undefined;
    }
    if (event.type === "foundation-check-failed") {
      this.error = event.message;
      this.activeOperationId = undefined;
      this.confirmRequest = undefined;
    }
  }
}

export function mountWindowStore(client: DesktopClient) {
  return mount(createStore(WindowStore, { client }));
}
