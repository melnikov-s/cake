import { Store } from "r-state-tree";
import { validateArtifactResponse, type ArtifactRecord } from "../../ipc/artifact-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import { describeError } from "../error-details";
import type { JsonValue } from "../../ipc/json-contract";

export interface ArtifactRequestState {
  operationId: string;
  artifactRequestId: string;
  record: ArtifactRecord;
}

export interface ArtifactInteractionStoreProps {
  client: Pick<DesktopClient, "respondToArtifact" | "exportArtifacts">;
  sessionContext(): { sessionId: string } | undefined;
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
      if (this.request === request) this.request = undefined;
    } catch (error) {
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    } finally {
      this.responding = false;
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
      return;
    }
    if (
      event.type === "pi-state-changed" &&
      (event.state === "failed" || event.state === "stopped")
    ) {
      this.request = undefined;
      this.responding = false;
    }
  }
}
