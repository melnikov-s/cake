import { Store, observable } from "r-state-tree";
import {
  stagedSessionSlashCommands,
  type ConversationSnapshot,
} from "../../contracts/conversations/session-contract";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";

type SlashCommand = ConversationSnapshot["commands"][number];

/** Owns the finite, non-executable command preview for one unsent session. */
export class StagedSessionCommandStore extends Store {
  readonly resourceCommands: SlashCommand[] = observable([]);
  error: string | undefined;
  errorDetails: string | undefined;
  private workspacePath: string | undefined;
  private pending: Promise<void> | undefined;
  private loadRevision = 0;
  private loadController: AbortController | undefined;

  get loading() {
    return this.pending !== undefined;
  }

  retry() {
    if (this.workspacePath) return this.load(this.workspacePath, true);
  }

  get commands(): ConversationSnapshot["commands"] {
    return [...stagedSessionSlashCommands, ...this.resourceCommands];
  }

  load(workspacePath: string, force = false) {
    if (this.signal.aborted) return;
    if (!force && this.workspacePath === workspacePath) return this.pending;
    this.workspacePath = workspacePath;
    this.pending = this.discover(workspacePath);
    return this.pending;
  }

  requireSkill(workspacePath: string, name: string) {
    if (this.workspacePath !== workspacePath)
      throw new Error("The skill search changed. Review your skill and send again.");
    if (this.error) throw new Error(`Could not check /${name}: ${this.error}`);
    if (
      !this.resourceCommands.some((command) => command.source === "skill" && command.name === name)
    )
      throw new Error(`/${name} is not available in the selected working directory.`);
  }

  private async discover(workspacePath: string) {
    const revision = ++this.loadRevision;
    this.loadController?.abort();
    const controller = new AbortController();
    this.loadController = controller;
    this.error = undefined;
    this.errorDetails = undefined;
    this.resourceCommands.splice(0);
    const signal = AbortSignal.any([this.signal, controller.signal]);

    try {
      // Allow load() to register the promise before either a synchronous failure or a reply.
      await Promise.resolve();
      signal.throwIfAborted();
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
      if (revision === this.loadRevision) {
        this.loadController = undefined;
        this.pending = undefined;
      }
    }
  }

  invalidate() {
    this.loadRevision += 1;
    this.workspacePath = undefined;
    this.pending = undefined;
    this.loadController?.abort();
    this.loadController = undefined;
    this.resourceCommands.splice(0);
    this.error = undefined;
    this.errorDetails = undefined;
  }
}
