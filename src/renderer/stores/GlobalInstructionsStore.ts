import { Store } from "r-state-tree";
import type { ApplicationState } from "../../contracts/conversations/session-contract";
import { describeError } from "../lib/error-details";
import { ClientContext } from "./context/ClientContext";

/** Owns one personal instruction scope and serializes field-level saves. */
export class GlobalInstructionsStore extends Store<{ scope?: "user" | "delegated" }> {
  instructions = "";
  saving = false;
  error: string | undefined;
  private applicationRevision = -1;
  private saveRevision = 0;
  private persisted = "";
  private saveQueue: Promise<unknown> = Promise.resolve();

  applyApplicationState(revision: number, state: ApplicationState) {
    if (revision <= this.applicationRevision) return;
    this.applicationRevision = revision;
    this.persisted =
      this.props.scope === "user"
        ? state.userSessionInstructions
        : this.props.scope === "delegated"
          ? state.delegatedSessionInstructions
          : state.globalCustomInstructions;
    if (!this.saving) this.instructions = this.persisted;
  }

  update(value: string) {
    const instructions = value.trim();
    const revision = ++this.saveRevision;
    this.instructions = instructions;
    this.saving = true;
    this.error = undefined;
    const save = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        const baseRevision = this.applicationRevision;
        const workspaces = ClientContext.consume(this)!.workspaces;
        if (this.props.scope)
          await workspaces.setSessionInstructions(this.props.scope, instructions, {
            signal: this.signal,
          });
        else await workspaces.setGlobalCustomInstructions(instructions, { signal: this.signal });
        return baseRevision;
      })
      .then((baseRevision) => {
        if (
          !this.signal.aborted &&
          revision === this.saveRevision &&
          this.applicationRevision > baseRevision
        )
          this.instructions = this.persisted;
      })
      .catch((error) => {
        if (this.signal.aborted || revision !== this.saveRevision) return;
        this.instructions = this.persisted;
        this.error = describeError(error).message;
      })
      .finally(() => {
        if (!this.signal.aborted && revision === this.saveRevision) this.saving = false;
      });
    this.saveQueue = save;
    return save;
  }
}
