import { Store, observable } from "r-state-tree";
import type {
  CompiledInlineWidget,
  InlineWidgetCapability,
  InlineWidgetLanguage,
} from "../../ipc/inline-widget-contract";
import { ClientContext } from "./context/ClientContext";

export interface InlineWidgetState {
  language: InlineWidgetLanguage;
  capability: InlineWidgetCapability;
  source: string;
  status: "building" | "ready" | "error";
  compiled?: CompiledInlineWidget;
  diagnostic?: string;
}

/** Owns compilation state for sandboxed inline transcript widgets. */
export class InlineWidgetStore extends Store {
  get inlineWidgets() {
    return ClientContext.consume(this)!.inlineWidgets;
  }

  readonly states: Record<string, InlineWidgetState> = observable({});
  private readonly revisions = new Map<string, number>();

  state(id: string) {
    return this.states[id];
  }

  prepare(
    id: string,
    language: InlineWidgetLanguage,
    source: string,
    capability: InlineWidgetCapability = "display",
  ) {
    const current = this.states[id];
    if (
      current?.language === language &&
      current.source === source &&
      current.capability === capability
    )
      return;
    const state = observable<InlineWidgetState>({
      language,
      capability,
      source,
      status: "building",
    });
    this.states[id] = state;
    void this.compile(id, state, source);
  }

  reportRuntimeError(id: string, diagnostic: string) {
    const state = this.states[id];
    if (!state) return;
    state.status = "error";
    state.diagnostic = diagnostic;
  }

  private async compile(
    id: string,
    state: InlineWidgetState,
    source: string,
    expectedRevision?: number,
  ) {
    const revision = expectedRevision ?? (this.revisions.get(id) ?? 0) + 1;
    this.revisions.set(id, revision);
    try {
      const compiled = await this.inlineWidgets.compile(state.language, source, state.capability);
      if (this.signal.aborted || this.revisions.get(id) !== revision || this.states[id] !== state)
        return;
      state.compiled = compiled;
      state.status = "ready";
      state.diagnostic = undefined;
    } catch (error) {
      if (this.signal.aborted || this.revisions.get(id) !== revision || this.states[id] !== state)
        return;
      state.compiled = undefined;
      state.status = "error";
      state.diagnostic = error instanceof Error ? error.message : String(error);
    }
  }
}
