import { Store, observable } from "r-state-tree";
import { stagedSessionSlashCommands, type SessionSnapshot } from "../../ipc/session-contract";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../error-details";

type SlashCommand = SessionSnapshot["commands"][number];

/** Owns the finite, non-executable command preview for one unsent session. */
export class StagedSessionCommandStore extends Store {
  readonly resourceCommands: SlashCommand[] = observable([]);
  error: string | undefined;
  errorDetails: string | undefined;
  private loadRevision = 0;
  private loadController: AbortController | undefined;

  get commands(): SessionSnapshot["commands"] {
    return [...stagedSessionSlashCommands, ...this.resourceCommands];
  }

  async load(workspacePath: string) {
    const revision = ++this.loadRevision;
    this.loadController?.abort();
    const controller = new AbortController();
    this.loadController = controller;
    this.error = undefined;
    this.errorDetails = undefined;
    this.resourceCommands.splice(0);
    const signal = AbortSignal.any([this.signal, controller.signal]);

    try {
      const commands = await ClientContext.consume(this)!.workspaces.loadStagedSlashCommands(
        workspacePath,
        { signal },
      );
      if (signal.aborted || revision !== this.loadRevision) return;
      this.resourceCommands.splice(0, this.resourceCommands.length, ...commands);
    } catch (error) {
      if (signal.aborted || revision !== this.loadRevision) return;
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    } finally {
      if (revision === this.loadRevision) this.loadController = undefined;
    }
  }

  invalidate() {
    this.loadRevision += 1;
    this.loadController?.abort();
    this.loadController = undefined;
    this.resourceCommands.splice(0);
    this.error = undefined;
    this.errorDetails = undefined;
  }
}
