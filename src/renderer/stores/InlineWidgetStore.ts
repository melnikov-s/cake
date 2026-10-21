import { Store, observable } from "r-state-tree";
import type {
  CompiledInlineWidget,
  InlineWidgetCapability,
  InlineWidgetLanguage,
} from "../../contracts/widgets/inline-widget-contract";
import type { WidgetBrowserOutput } from "../../contracts/widgets/widget-browser-output";
import { ClientContext } from "./context/ClientContext";
import { WidgetViewAttachmentContext } from "./context/WidgetViewAttachmentContext";
import type { ArtifactState } from "../../contracts/artifacts/artifact-state";
import type { ArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";
import type { JsonValue } from "../../contracts/serialization/json-contract";

export interface InlineWidgetState {
  language: InlineWidgetLanguage;
  capability: InlineWidgetCapability;
  source: string;
  browser?: WidgetBrowserOutput;
  status: "building" | "ready" | "error";
  compiled?: CompiledInlineWidget;
  diagnostic?: string;
}

/** Owns compilation state for sandboxed inline transcript widgets. */
export class InlineWidgetStore extends Store {
  constructor(props: InlineWidgetStore["props"]) {
    super(props);
    this.effect(() => {
      const widgets = this.inlineWidgets;
      return () => {
        for (const [id, state] of Object.entries(this.states)) {
          if (state.compiled) void widgets.release(state.compiled.token).catch(() => undefined);
          this.clearBrowserReadyDeadline(id);
          delete this.states[id];
        }
        this.revisions.clear();
      };
    });
  }

  private releaseCompiled(compiled: CompiledInlineWidget | undefined) {
    if (compiled) void this.inlineWidgets.release(compiled.token).catch(() => undefined);
  }

  /** Each mounted surface owns its compilation, including any still-pending result. */
  release(id: string) {
    this.clearBrowserReadyDeadline(id);
    this.releaseCompiled(this.states[id]?.compiled);
    delete this.states[id];
    this.revisions.delete(id);
  }

  evidenceBusy = false;
  evidenceViewId: string | undefined;
  evidenceMessage: string | undefined;
  evidenceFailed = false;

  async attachCurrentView(viewId: string) {
    if (this.evidenceBusy) return;
    this.evidenceBusy = true;
    this.evidenceViewId = viewId;
    this.evidenceMessage = undefined;
    this.evidenceFailed = false;
    try {
      const attachments = WidgetViewAttachmentContext.consume(this);
      if (!attachments) throw new Error("Current-view attachment is unavailable in this window.");
      await attachments.attachWidgetView(viewId);
      if (!this.signal.aborted)
        this.evidenceMessage = "Current view + revision added to draft. Send when ready.";
    } catch (error) {
      if (!this.signal.aborted) {
        this.evidenceFailed = true;
        this.evidenceMessage = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.evidenceBusy = false;
    }
  }

  get inlineWidgets() {
    return ClientContext.consume(this)!.inlineWidgets;
  }

  readonly artifactStates = observable<
    Record<
      string,
      {
        sessionId: string;
        lineageId: ArtifactLineageId;
        current?: ArtifactState;
        error?: string;
        loading: boolean;
      }
    >
  >({});
  bindArtifactState(id: string, sessionId: string, lineageId: ArtifactLineageId) {
    const current = this.artifactStates[id];
    if (current?.sessionId === sessionId && current.lineageId === lineageId) return;
    this.artifactStates[id] = observable({ sessionId, lineageId, loading: false });
    void this.readArtifactState(id).catch(() => undefined);
  }
  releaseArtifactState(id: string) {
    delete this.artifactStates[id];
  }
  refreshArtifactState(lineageId?: string) {
    for (const [id, state] of Object.entries(this.artifactStates))
      if (!lineageId || state.lineageId === lineageId)
        void this.readArtifactState(id).catch(() => undefined);
  }
  async readArtifactState(id: string) {
    const binding = this.artifactStates[id];
    if (!binding) throw new Error("This widget has no linked artifact state scope");
    binding.loading = true;
    try {
      const state = await ClientContext.consume(this)!.artifacts.stateRead(
        { sessionId: binding.sessionId, lineageId: binding.lineageId },
        { signal: this.signal },
      );
      if (!this.signal.aborted && this.artifactStates[id] === binding) {
        if (!binding.current || binding.current.version <= state.version) binding.current = state;
        binding.error = undefined;
      }
      return state;
    } catch (error) {
      if (!this.signal.aborted && this.artifactStates[id] === binding)
        binding.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (!this.signal.aborted && this.artifactStates[id] === binding) binding.loading = false;
    }
  }
  async saveArtifactState(id: string, value: JsonValue, expectedVersion: number) {
    const binding = this.artifactStates[id];
    if (!binding?.current || binding.error)
      throw new Error("Artifact state is not hydrated; read before saving");
    try {
      const state = await ClientContext.consume(this)!.artifacts.stateReplace(
        { sessionId: binding.sessionId, lineageId: binding.lineageId, expectedVersion, value },
        { signal: this.signal },
      );
      if (
        !this.signal.aborted &&
        this.artifactStates[id] === binding &&
        (!binding.current || binding.current.version <= state.version)
      )
        binding.current = state;
      return state;
    } catch (error) {
      // Refresh after conflicts; never retry an obsolete value over the user's/agent's newer state.
      void this.readArtifactState(id).catch(() => undefined);
      throw error;
    }
  }

  readonly states: Record<string, InlineWidgetState> = observable({});
  private readonly revisions = new Map<string, number>();
  private readonly browserReadyDeadlines = new Map<string, ReturnType<typeof setTimeout>>();

  private clearBrowserReadyDeadline(id: string) {
    clearTimeout(this.browserReadyDeadlines.get(id));
    this.browserReadyDeadlines.delete(id);
  }

  /** Only the owning frame's authenticated ready message completes a browser mount. */
  browserViewReady(id: string, token: string) {
    if (this.states[id]?.compiled?.token === token) this.clearBrowserReadyDeadline(id);
  }

  /** Retry the accepted immutable browser output, never regenerate or recompile source. */
  retryBrowserView(id: string) {
    const browser = this.states[id]?.browser;
    if (!browser) return;
    this.release(id);
    this.prepareBrowser(id, browser);
  }

  state(id: string) {
    return this.states[id];
  }

  /** Published document tokens belong to the backend process, not the browser tab. */
  backendReconnected() {
    for (const [id, state] of Object.entries(this.states)) {
      const revision = (this.revisions.get(id) ?? 0) + 1;
      this.revisions.set(id, revision);
      this.clearBrowserReadyDeadline(id);
      this.releaseCompiled(state.compiled);
      state.compiled = undefined;
      state.diagnostic = undefined;
      state.status = "building";
      void this.compile(id, state, state.source, revision);
    }
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
    this.release(id);
    const state = observable<InlineWidgetState>({
      language,
      capability,
      source,
      status: "building",
    });
    this.states[id] = state;
    void this.compile(id, state, source);
  }

  /** Accepted browser output is immutable; neither reopen nor reconnect recompiles source. */
  prepareBrowser(id: string, browser: WidgetBrowserOutput) {
    if (this.states[id]?.browser?.digest === browser.digest) return;
    this.release(id);
    const state = observable<InlineWidgetState>({
      language: "react",
      capability: "display",
      source: "",
      browser,
      status: "building",
    });
    this.states[id] = state;
    void this.compile(id, state, "");
  }

  reportRuntimeError(id: string, diagnostic: string) {
    const state = this.states[id];
    if (!state) return;
    this.clearBrowserReadyDeadline(id);
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
    // Capture the capability before awaiting: disposed Stores no longer have mounted Context.
    const widgets = this.inlineWidgets;
    try {
      const compiled = state.browser
        ? await widgets.open(state.browser)
        : await widgets.compile(state.language, source, state.capability);
      if (this.signal.aborted || this.revisions.get(id) !== revision || this.states[id] !== state) {
        void widgets.release(compiled.token).catch(() => undefined);
        return;
      }
      state.compiled = compiled;
      state.status = "ready";
      state.diagnostic = undefined;
      if (state.browser) {
        // A successful open publishes a URL, not proof that its iframe loaded.
        // Navigation failures do not necessarily emit a widget runtime error.
        this.browserReadyDeadlines.set(
          id,
          setTimeout(() => {
            if (this.states[id] === state && state.compiled?.token === compiled.token)
              this.reportRuntimeError(
                id,
                "The widget did not finish loading. Retry this view to open the same saved revision again.",
              );
          }, 15_000),
        );
      }
    } catch (error) {
      if (this.signal.aborted || this.revisions.get(id) !== revision || this.states[id] !== state)
        return;
      state.compiled = undefined;
      state.status = "error";
      state.diagnostic = error instanceof Error ? error.message : String(error);
    }
  }
}
