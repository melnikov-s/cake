import { Store } from "r-state-tree";
import type { ProjectSessionControlInvocation } from "../../domain/project-sessions/project-session-data";
import type { JsonValue } from "../../ipc/json-contract";
import { ClientContext } from "./context/ClientContext";
import type { SessionLayoutStore } from "./SessionLayoutStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";

export interface ProjectSessionPlacementStoreProps {
  registry: SessionRegistryStore;
  layout: SessionLayoutStore;
  requireWorkingDirectory(sessionId: string): string;
  dismissSecondarySurfaces(): void;
  selectSession(sessionId: string): void;
  showLoadedSession(sessionId: string): void;
}

/**
 * Owns runtime opening and optional pane placement for agent-created Project Sessions.
 * Pi/main owns the created transcript and family membership; this window-scoped Store owns only
 * renderer registration, open-before-command sequencing, placement, and failed-open cleanup.
 * Each request runs independently because the main authority serializes creation per source.
 */
export class ProjectSessionPlacementStore extends Store<ProjectSessionPlacementStoreProps> {
  private get client() {
    return ClientContext.consume(this)!;
  }

  async fork(
    sourceSessionId: string,
    input: Extract<ProjectSessionControlInvocation, { _tag: "ForkSession" }>,
  ): Promise<JsonValue> {
    const sourceWorkingDirectory = this.props.requireWorkingDirectory(sourceSessionId);
    const destinationWorkingDirectory = input.destinationWorkingDirectory ?? sourceWorkingDirectory;
    const result = await this.client.projectSessions.fork(
      {
        sessionId: sourceSessionId,
        workingDirectory: sourceWorkingDirectory,
        entryId: input.entryId,
        resolveSource: input.resolveSource,
        destinationWorkingDirectory,
      },
      { signal: this.signal },
    );

    // Forking writes the transcript but does not assemble its Pi runtime. Register it first so
    // observation can begin, then open the runtime before rename or prompt commands are issued.
    this.props.registry.load(result.sessionId, destinationWorkingDirectory);
    try {
      await this.client.projectSessions.open(
        { sessionId: result.sessionId, workingDirectory: destinationWorkingDirectory },
        { signal: this.signal },
      );
    } catch (error) {
      this.props.registry.removeSession(result.sessionId);
      throw error;
    }
    if (input.title !== undefined)
      await this.client.projectSessions.rename(
        {
          sessionId: result.sessionId,
          workingDirectory: destinationWorkingDirectory,
          name: input.title,
        },
        { signal: this.signal },
      );
    if (input.prompt !== undefined)
      await this.client.sessionChats.prompt(
        {
          sessionId: result.sessionId,
          text: input.prompt,
          attachments: [],
          renderUserMessageAsMarkdown: false,
        },
        { signal: this.signal },
      );
    if (input.placement === "none")
      return {
        ok: true,
        sessionId: result.sessionId,
        placement: input.placement,
        sourceResolved: input.resolveSource,
      };

    const paneId = this.props.layout.showChildSession(
      sourceSessionId,
      result.sessionId,
      input.placement === "right" ? "x" : "y",
    );
    if (!paneId) throw new Error("Cake could not open the fork beside its source session.");
    this.present(result.sessionId);
    return {
      ok: true,
      sessionId: result.sessionId,
      placement: input.placement,
      paneId,
      sourceResolved: input.resolveSource,
    };
  }

  async openChild(
    parentSessionId: string,
    input: Extract<ProjectSessionControlInvocation, { _tag: "ProjectChildSession" }>,
  ): Promise<JsonValue> {
    this.props.registry.loadUnlistedFamilySession(
      input.childSessionId,
      input.workingDirectory,
      input.title,
      {
        familyId: input.familyId,
        parentSessionId,
        childOrder: input.familyChildOrder,
        depth: input.familyDepth,
      },
    );
    try {
      await this.client.projectSessions.open(
        { sessionId: input.childSessionId, workingDirectory: input.workingDirectory },
        { signal: this.signal },
      );
    } catch (error) {
      this.props.registry.removeSession(input.childSessionId);
      throw error;
    }
    if (input.placement === "none")
      return { ok: true, childSessionId: input.childSessionId, placement: input.placement };

    const paneId = this.props.layout.showChildSession(
      parentSessionId,
      input.childSessionId,
      input.placement === "right" ? "x" : "y",
    );
    if (!paneId) throw new Error("Cake could not open a child pane beside its parent.");
    this.present(input.childSessionId);
    return { ok: true, childSessionId: input.childSessionId, placement: input.placement, paneId };
  }

  private present(sessionId: string) {
    this.props.dismissSecondarySurfaces();
    this.props.selectSession(sessionId);
    this.props.showLoadedSession(sessionId);
  }
}
