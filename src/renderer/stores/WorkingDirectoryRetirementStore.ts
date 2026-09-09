import { Store } from "r-state-tree";
import { ClientContext } from "./context/ClientContext";

export interface WorkingDirectoryRetirementWorkflow {
  prepare(workingDirectories: readonly string[]): Promise<boolean>;
}

interface PendingRetirement {
  workingDirectories: readonly string[];
  finish(proceed: boolean): void;
}

/** Owns window-local Working Directory retirement preflight and confirmation presentation. */
export class WorkingDirectoryRetirementStore extends Store<{
  onRetired(workingDirectories: readonly string[]): void;
}> {
  confirmationRequest: { runningProgramCount: number } | undefined;
  private pending: PendingRetirement | undefined;
  private retiringDirectories: readonly string[] = [];

  constructor(props: WorkingDirectoryRetirementStore["props"]) {
    super(props);
    this.effect(() => () => this.finish(false));
  }

  private get terminals() {
    return ClientContext.consume(this)!.terminals;
  }

  isRetiring(workingDirectory: string) {
    return this.retiringDirectories.includes(workingDirectory);
  }

  /** Ignores concurrent/repeated requests while one retirement is inspecting or confirming. */
  async prepare(workingDirectories: readonly string[]) {
    const directories = [...new Set(workingDirectories)];
    if (directories.length === 0) return true;
    if (this.retiringDirectories.length > 0 || this.signal.aborted) return false;
    this.retiringDirectories = directories;
    try {
      // Main inspects the same all-window collection that retirement will close.
      // A failed inspection must not be interpreted as an idle shell.
      const statuses = await Promise.all(
        directories.map((directory) =>
          this.terminals.workingDirectoryStatus(directory, { signal: this.signal }),
        ),
      );
      if (this.signal.aborted) return false;
      const runningProgramCount = statuses.reduce(
        (total, status) => total + status.runningProgramCount,
        0,
      );
      if (runningProgramCount === 0) return this.close(directories);
      return await new Promise<boolean>((finish) => {
        this.pending = { workingDirectories: directories, finish };
        this.confirmationRequest = { runningProgramCount };
      });
    } catch (error) {
      if (this.signal.aborted) return false;
      throw error;
    } finally {
      if (!this.signal.aborted) this.retiringDirectories = [];
    }
  }

  cancel() {
    this.finish(false);
  }

  async confirm() {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    this.confirmationRequest = undefined;
    try {
      pending.finish(await this.close(pending.workingDirectories));
    } catch {
      pending.finish(false);
    }
  }

  private finish(proceed: boolean) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    this.confirmationRequest = undefined;
    pending.finish(proceed);
  }

  private async close(workingDirectories: readonly string[]) {
    await Promise.all(
      workingDirectories.map((workingDirectory) =>
        this.terminals.closeWorkingDirectory(workingDirectory, { signal: this.signal }),
      ),
    );
    if (this.signal.aborted) return false;
    this.props.onRetired(workingDirectories);
    return true;
  }
}
