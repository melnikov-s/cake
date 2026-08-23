import { Store } from "r-state-tree";
import { validateArtifactResponse, type ArtifactRecord } from "../../ipc/artifact-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import { describeError } from "../error-details";
import type { JsonValue } from "../../ipc/json-contract";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export interface ArtifactRequestState {
  operationId: string;
  artifactRequestId: string;
  record: ArtifactRecord;
}

export interface ArtifactInteractionStoreProps {
  client: Pick<DesktopClient, "respondToArtifact" | "submit" | "exportArtifacts">;
  sessionContext(): { sessionId: string } | undefined;
  operations: SessionOperationCoordinatorStore;
  operationOwner: string;
  isStreaming(): boolean;
  onRequestChanged?(active: boolean): void;
}

/** Owns blocking artifact interaction and artifact export behavior. */
export class ArtifactInteractionStore extends Store<ArtifactInteractionStoreProps> {
  request: ArtifactRequestState | undefined;
  responding = false;
  error: string | undefined;
  errorDetails: string | undefined;

  async respond(value?: JsonValue, cancelled = false) {
    const request = this.request;
    if (!request || this.responding) return;
    this.error = undefined;
    this.errorDetails = undefined;
    try {
      if (!cancelled)
        validateArtifactResponse(request.record.artifact.interaction?.responseSchema, value);
      this.responding = true;
      const context = this.props.sessionContext();
      if (!context) throw new Error("No active session");
      await this.props.client.respondToArtifact({
        operationId: request.operationId,
        sessionId: context.sessionId,
        artifactRequestId: request.artifactRequestId,
        value,
        cancelled,
      });
      if (this.signal.aborted) return;
      if (this.request === request) {
        this.request = undefined;
        this.props.onRequestChanged?.(false);
      }
    } catch (error) {
      if (this.signal.aborted) return;
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    } finally {
      if (!this.signal.aborted) this.responding = false;
    }
  }

  async cancelPendingRequest() {
    if (this.request) await this.respond(undefined, true);
    if (this.request) {
      this.request = undefined;
      this.props.onRequestChanged?.(false);
    }
  }

  /**
   * Deliver an answer for a request artifact. While the agent is blocked on
   * this exact request, resolve the pending operation; otherwise send the
   * answer as a new prompt (steered mid-turn, plain when idle) so a submit
   * never silently does nothing.
   */
  async answer(record: ArtifactRecord, value?: JsonValue) {
    const live = this.request?.record.artifact.id === record.artifact.id ? this.request : undefined;
    if (live) return this.respond(value);
    await this.deliverLateAnswer(record, value);
  }

  private async deliverLateAnswer(record: ArtifactRecord, value: JsonValue | undefined) {
    const context = this.props.sessionContext();
    if (!context) throw new Error("No active session");
    this.error = undefined;
    this.errorDetails = undefined;
    const title = record.artifact.title ?? record.artifact.id;
    const text = `I answered the earlier request "${title}": ${JSON.stringify(value ?? null)}`;
    const operationId = this.props.operations.start(this.props.operationOwner);
    try {
      await this.props.client.submit({
        operationId,
        sessionId: context.sessionId,
        text,
        delivery: this.props.isStreaming() ? "steer" : "prompt",
        attachments: [],
      });
    } catch (error) {
      if (this.signal.aborted) return;
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    } finally {
      this.props.operations.finish(operationId);
    }
  }

  async exportMarkdown() {
    const context = this.props.sessionContext();
    if (!context) throw new Error("No active session");
    return this.props.client.exportArtifacts(context.sessionId);
  }

  receive(event: DesktopClientEvent) {
    if (event.type === "artifact-requested") {
      // Register even while another session is selected: the user may switch
      // back later, and the main process stays blocked until one response (or
      // cancellation) arrives. Replayed requests overwrite harmlessly.
      if (event.record.artifact.sessionId !== this.props.sessionContext()?.sessionId) return;
      this.request = event;
      this.props.onRequestChanged?.(true);
      return;
    }
    if (
      event.type === "pi-state-changed" &&
      (event.state === "failed" || event.state === "stopped")
    ) {
      this.request = undefined;
      this.responding = false;
      this.props.onRequestChanged?.(false);
    }
  }
}
