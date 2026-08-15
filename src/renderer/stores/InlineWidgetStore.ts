import { Store, observable } from "r-state-tree";
import type { CompiledInlineWidget, InlineWidgetCapability, InlineWidgetLanguage } from "../../ipc/inline-widget-contract";
import type { DesktopClient } from "../desktop-client";

export interface InlineWidgetState {
  language: InlineWidgetLanguage;
  capability: InlineWidgetCapability;
  source: string;
  status: "building" | "ready" | "error" | "repairing";
  compiled?: CompiledInlineWidget;
  diagnostic?: string;
  repairSessionId?: string;
}

export interface InlineWidgetRepairInput {
  id: string;
  workspacePath: string;
  sessionId: string;
  context: string;
  model?: { provider: string; id: string };
}

/** Owns compilation and dedicated-agent repair policy for inline transcript widgets. */
export class InlineWidgetStore extends Store<{ client: DesktopClient }> {
  readonly states: Record<string, InlineWidgetState> = observable({});
  private readonly revisions = new Map<string, number>();

  state(id: string) {
    return this.states[id];
  }

  prepare(id: string, language: InlineWidgetLanguage, source: string, capability: InlineWidgetCapability = "display") {
    const current = this.states[id];
    if (current?.language === language && current.source === source && current.capability === capability) return;
    const state = observable<InlineWidgetState>({ language, capability, source, status: "building" });
    this.states[id] = state;
    void this.compile(id, state, source);
  }

  reportRuntimeError(id: string, diagnostic: string) {
    const state = this.states[id];
    if (!state || state.status === "repairing") return;
    state.status = "error";
    state.diagnostic = diagnostic;
  }

  async repair(input: InlineWidgetRepairInput) {
    const state = this.states[input.id];
    if (!state || state.status === "repairing") return;
    state.status = "repairing";
    const revision = (this.revisions.get(input.id) ?? 0) + 1;
    this.revisions.set(input.id, revision);
    try {
      const repaired = await this.props.client.repairInlineWidget({
        workspacePath: input.workspacePath,
        sessionId: input.sessionId,
        language: state.language,
        capability: state.capability,
        source: state.source,
        context: input.context,
        diagnostic: state.diagnostic,
        model: input.model
      });
      if (this.signal.aborted || this.revisions.get(input.id) !== revision) return;
      state.source = repaired.source;
      state.repairSessionId = repaired.repairSessionId;
      state.diagnostic = undefined;
      state.status = "building";
      await this.compile(input.id, state, repaired.source, revision);
    } catch (error) {
      if (this.signal.aborted || this.revisions.get(input.id) !== revision) return;
      state.status = "error";
      state.diagnostic = error instanceof Error ? error.message : String(error);
    }
  }

  private async compile(id: string, state: InlineWidgetState, source: string, expectedRevision?: number) {
    const revision = expectedRevision ?? (this.revisions.get(id) ?? 0) + 1;
    this.revisions.set(id, revision);
    try {
      const compiled = await this.props.client.compileInlineWidget(state.language, source, state.capability);
      if (this.signal.aborted || this.revisions.get(id) !== revision || this.states[id] !== state) return;
      state.compiled = compiled;
      state.status = "ready";
      state.diagnostic = undefined;
    } catch (error) {
      if (this.signal.aborted || this.revisions.get(id) !== revision || this.states[id] !== state) return;
      state.compiled = undefined;
      state.status = "error";
      state.diagnostic = error instanceof Error ? error.message : String(error);
    }
  }
}
