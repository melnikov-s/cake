import { Store } from "r-state-tree";
import type { ArtifactRecord } from "../../ipc/artifact-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";

export interface ArtifactRequestState {
  operationId: string;
  artifactRequestId: string;
  record: ArtifactRecord;
}

export interface ArtifactInteractionStoreProps {
  client: DesktopClient;
  sessionContext(): { workspacePath: string; sessionId: string } | undefined;
  isActiveSession(workspacePath: string, sessionId: string): boolean;
  operationActive(operationId: string): boolean;
  reportError(error: unknown): void;
}

/** Owns blocking artifact interaction and artifact export behavior. */
export class ArtifactInteractionStore extends Store<ArtifactInteractionStoreProps> {
  request: ArtifactRequestState | undefined;

  async respond(value?: unknown, cancelled = false) {
    const request = this.request;
    if (!request) return;
    this.request = undefined;
    try {
      const context = this.props.sessionContext();
      if (!context) throw new Error("No active session");
      await this.props.client.respondToArtifact({ operationId: request.operationId, ...context, artifactRequestId: request.artifactRequestId, value, cancelled });
    } catch (error) {
      this.props.reportError(error);
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
    if (event.type === "pi-state-changed" && (event.state === "failed" || event.state === "stopped")) this.request = undefined;
  }
}
