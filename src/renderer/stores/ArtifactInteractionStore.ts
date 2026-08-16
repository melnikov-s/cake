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
  sessionContext(): { workspacePath: string; sessionId: string } | undefined;
  isActiveSession(workspacePath: string, sessionId: string): boolean;
  operationActive(operationId: string): boolean;
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
    this.error = undefined; this.errorDetails = undefined;
    try {
      if (!cancelled) validateArtifactResponse(request.record.artifact.interaction?.responseSchema, value);
      this.responding = true;
      const context = this.props.sessionContext();
      if (!context) throw new Error("No active session");
      await this.props.client.respondToArtifact({ operationId: request.operationId, ...context, artifactRequestId: request.artifactRequestId, value, cancelled });
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
    return this.props.client.exportArtifacts(context.workspacePath, context.sessionId);
  }

  receive(event: DesktopClientEvent) {
    if (event.type === "artifact-requested") {
      if (!this.props.operationActive(event.operationId) || !this.props.isActiveSession(event.record.workspacePath, event.record.artifact.sessionId)) return;
      this.request = event;
      return;
    }
    if (event.type === "pi-state-changed" && (event.state === "failed" || event.state === "stopped")) {
      this.request = undefined;
      this.responding = false;
    }
  }
}
