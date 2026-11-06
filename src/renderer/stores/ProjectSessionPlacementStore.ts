import { Store } from "r-state-tree";
import type { ProjectSessionControlInvocation } from "../../contracts/project-sessions/project-session-data";
import type { JsonValue } from "../../contracts/serialization/json-contract";
import { ClientContext } from "./context/ClientContext";
import { SessionRegistryContext } from "./context/SessionRegistryContext";
import { SessionMetadataContext } from "./context/SessionMetadataContext";

export interface ProjectSessionPlacementStoreProps {
  dismissSecondarySurfaces(): void;
  selectSession(sessionId: string): void;
  showLoadedSession(sessionId: string): void;
}

/**
 * Owns runtime opening and optional conversation selection for agent-created Project Sessions.
 * Pi/main owns the created transcript and family membership; this window-scoped Store owns only
 * renderer registration, open-before-command sequencing, selection, and failed-open cleanup.
 * Each request runs independently because the main authority serializes creation per source.
 */
export class ProjectSessionPlacementStore extends Store<ProjectSessionPlacementStoreProps> {
  private get client() {
    return ClientContext.consume(this)!;
  }

  private get registry() {
    return SessionRegistryContext.consume(this)!;
  }

  private get metadata() {
    return SessionMetadataContext.consume(this)!;
  }

  async fork(
    sourceSessionId: string,
    input: Extract<ProjectSessionControlInvocation, { _tag: "ForkSession" }>,
  ): Promise<JsonValue> {
    const sourceWorkingDirectory = this.metadata.workingDirectory(sourceSessionId);
    if (!sourceWorkingDirectory) throw new Error("Cake could not find that session");
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
    this.registry.load(result.sessionId, destinationWorkingDirectory);
    try {
      await this.client.projectSessions.open(
        { sessionId: result.sessionId, workingDirectory: destinationWorkingDirectory },
        { signal: this.signal },
      );
    } catch (error) {
      this.registry.removeSession(result.sessionId);
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
    if (!input.open)
      return {
        ok: true,
        sessionId: result.sessionId,
        opened: input.open,
        sourceResolved: input.resolveSource,
      };

    this.present(result.sessionId);
    return {
      ok: true,
      sessionId: result.sessionId,
      opened: input.open,
      sourceResolved: input.resolveSource,
    };
  }

  async presentFork(
    input: Extract<ProjectSessionControlInvocation, { _tag: "PresentForkSession" }>,
  ): Promise<JsonValue> {
    this.registry.load(input.forkSessionId, input.workingDirectory);
    this.present(input.forkSessionId);
    return { ok: true, sessionId: input.forkSessionId, opened: true };
  }

  async openChild(
    parentSessionId: string,
    input: Extract<ProjectSessionControlInvocation, { _tag: "ProjectChildSession" }>,
  ): Promise<JsonValue> {
    this.registry.loadUnlistedFamilySession(
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
      this.registry.removeSession(input.childSessionId);
      throw error;
    }
    if (!input.open) return { ok: true, childSessionId: input.childSessionId, opened: input.open };

    this.present(input.childSessionId);
    return { ok: true, childSessionId: input.childSessionId, opened: input.open };
  }

  private present(sessionId: string) {
    this.props.dismissSecondarySurfaces();
    this.props.selectSession(sessionId);
    this.props.showLoadedSession(sessionId);
  }
}
