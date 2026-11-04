import { Store, observable } from "r-state-tree";
import type { EditorLocation } from "../../contracts/editor/editor-location";
import type {
  EditorSelection,
  EditorSelectionId,
  EditorSelectionLocation,
  EditorSelectionOpenResult,
  EditorSelectionReveal,
  EditorSelectionState,
  EditorSelectionUpdate,
  EditorSelectionsWriteResult,
} from "../../contracts/editor/editor-selection";

export interface EditorSelectionsStoreProps {
  sessionId: string;
  /** Native navigation only; the parent ensures this session owns the visible editor. */
  openLocation(location: EditorLocation, signal: AbortSignal): Promise<EditorSelectionReveal>;
  /** Parent sends only active selections' locations to VS Code, never IDs or session identity. */
  refreshHighlights(): Promise<void>;
}

function locationKey(location: EditorSelectionLocation): string {
  const { start, end } = location.range;
  return JSON.stringify([
    location.kind,
    location.path,
    location.view,
    location.view === "changes" ? location.side : null,
    location.view === "changes" ? location.base : null,
    start.line,
    start.column ?? 0,
    end?.line ?? start.line,
    end?.column ?? (end ? 0 : (start.column ?? 0)),
  ]);
}

/** Ephemeral selection authority for exactly one retained project session. */
export class EditorSelectionsStore extends Store<EditorSelectionsStoreProps> {
  readonly selections: EditorSelection[] = observable([]);
  error: string | undefined;
  private pending: Promise<void> = Promise.resolve();

  private ensureActive(): void {
    if (this.signal.aborted) throw new DOMException("Selection Store disposed", "AbortError");
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(async () => {
      this.ensureActive();
      return operation();
    });
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async navigate(location: EditorLocation): Promise<EditorSelectionReveal> {
    try {
      const reveal = await this.props.openLocation(location, this.signal);
      this.ensureActive();
      this.error = undefined;
      return reveal;
    } catch (error) {
      this.ensureActive();
      this.error = `Could not open editor location: ${error instanceof Error ? error.message : String(error)}`;
      throw error;
    }
  }

  private async refresh(): Promise<string | undefined> {
    try {
      await this.props.refreshHighlights();
      this.ensureActive();
      this.error = undefined;
      return undefined;
    } catch (error) {
      this.ensureActive();
      const warning = `Could not refresh selection highlights: ${error instanceof Error ? error.message : String(error)}`;
      this.error = warning;
      return warning;
    }
  }

  /** Copy current state for agent replies; callers do not get the mutable collection. */
  list(): EditorSelectionState {
    return { sessionId: this.props.sessionId, selections: structuredClone([...this.selections]) };
  }

  /** Navigate and append resolved ranges, reusing exact normalized duplicates. */
  open(location: EditorLocation): Promise<EditorSelectionOpenResult> {
    return this.serialize(async () => {
      const reveal = await this.navigate(location);
      const selectionIds = reveal.locations.map((resolved) => {
        const key = locationKey(resolved);
        const existing = this.selections.find(
          (selection) => locationKey(selection.location) === key,
        );
        if (existing) return existing.id;
        // SAFETY: crypto.randomUUID() generates a nonempty 36-character string within EditorSelectionId's bounds.
        const id = crypto.randomUUID() as EditorSelectionId;
        this.selections.push({ id, location: structuredClone(resolved) });
        return id;
      });
      const warning = selectionIds.length > 0 ? await this.refresh() : undefined;
      return warning ? { reveal, selectionIds, warning } : { reveal, selectionIds };
    });
  }

  /** Navigation-only tool path: never registers ranges or refreshes highlights. */
  navigateFile(location: EditorLocation): Promise<EditorSelectionReveal> {
    return this.serialize(() => this.navigate(location));
  }

  /** Resolve the entire batch before publishing one replacement/append and one projection. */
  write(
    locations: readonly EditorLocation[],
    replace: boolean,
  ): Promise<EditorSelectionsWriteResult> {
    return this.serialize(async () => {
      if (locations.length === 0 && !replace)
        return { state: this.list(), selectionIds: [], reveals: [] };
      const reveals: EditorSelectionReveal[] = [];
      for (const location of locations) {
        const reveal = await this.navigate(location);
        if (reveal.locations.length === 0)
          throw new Error("The requested source range could not be resolved for selection.");
        reveals.push(reveal);
      }
      const next = replace ? [] : [...this.selections];
      const selectionIds = reveals.flatMap((reveal) =>
        reveal.locations.map((location) => {
          const key = locationKey(location);
          const existing =
            next.find((selection) => locationKey(selection.location) === key) ??
            this.selections.find((selection) => locationKey(selection.location) === key);
          // SAFETY: crypto.randomUUID() satisfies EditorSelectionId's nonempty length bounds.
          const selection = existing ?? {
            id: crypto.randomUUID() as EditorSelectionId,
            location: structuredClone(location),
          };
          if (!next.some(({ id }) => id === selection.id)) next.push(selection);
          return selection.id;
        }),
      );
      this.selections.splice(0, this.selections.length, ...next);
      const warning = await this.refresh();
      return { state: this.list(), selectionIds, reveals, ...(warning ? { warning } : null) };
    });
  }

  /** Navigate by ID without adding; reject a removed ID rather than recreating it. */
  reveal(id: EditorSelectionId): Promise<EditorSelectionReveal> {
    return this.serialize(async () => {
      const selection = this.selections.find((candidate) => candidate.id === id);
      if (!selection) throw new Error(`Unknown selection: ${id}`);
      const location = selection.location;
      const request: EditorLocation =
        location.view === "changes"
          ? {
              kind: "working-directory",
              path: location.path,
              view: "changes",
              side: location.side,
              base: location.base,
              range: location.range,
            }
          : { kind: location.kind, path: location.path, range: location.range };
      return this.navigate(request);
    });
  }

  /** Remove locally, then refresh highlights; unknown IDs are idempotent. */
  remove(id: EditorSelectionId): Promise<EditorSelectionUpdate> {
    return this.serialize(async () => {
      const index = this.selections.findIndex((selection) => selection.id === id);
      if (index < 0) return { state: this.list() };
      this.selections.splice(index, 1);
      const warning = await this.refresh();
      const state = this.list();
      return warning ? { state, warning } : { state };
    });
  }

  /** Works while hidden; never clears another session's collection. */
  clear(): Promise<EditorSelectionUpdate> {
    return this.serialize(async () => {
      if (this.selections.length === 0) return { state: this.list() };
      this.selections.splice(0);
      const warning = await this.refresh();
      const state = this.list();
      return warning ? { state, warning } : { state };
    });
  }
}
