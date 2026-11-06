import { Store, observable, untracked } from "r-state-tree";
import type {
  ArtifactViewReference,
  ArtifactViewingReport,
} from "../../contracts/artifacts/artifact-viewing";
import { ClientContext } from "./context/ClientContext";

/** Disposable window projection. RPC connection identity, not a generated window ID, owns it. */
export class ArtifactViewingStore extends Store {
  private readonly surfaces = observable<{ id: string; entry: ArtifactViewReference }[]>([]);
  private activeId: string | undefined;
  private reporting = false;
  private reportVersion = 0;
  private publication: Promise<void> = Promise.resolve();
  error: string | undefined;

  constructor(props: ArtifactViewingStore["props"]) {
    super(props);
    this.effect(() => {
      if (!this.reporting) return;
      void this.reportVersion;
      const snapshot = this.snapshot;
      // Mounts/interaction/removals must reach the backend in that same order.
      untracked(() => {
        this.publication = this.publication.then(async () => {
          if (this.signal.aborted) return;
          try {
            await ClientContext.consume(this)!.artifacts.reportViewing(snapshot, {
              signal: this.signal,
            });
            this.error = undefined;
          } catch (error) {
            if (!this.signal.aborted)
              this.error = error instanceof Error ? error.message : String(error);
          }
        });
      });
    });
  }

  refresh() {
    if (this.reporting) this.reportVersion += 1;
  }

  show(id: string, entry: ArtifactViewReference) {
    this.reporting = true;
    const existing = this.surfaces.find((surface) => surface.id === id);
    if (existing) existing.entry = entry;
    else this.surfaces.push({ id, entry });
  }

  activate(id: string) {
    if (this.surfaces.some((surface) => surface.id === id)) this.activeId = id;
  }

  hide(id: string) {
    const index = this.surfaces.findIndex((surface) => surface.id === id);
    if (index >= 0) this.surfaces.splice(index, 1);
    if (this.activeId === id) this.activeId = undefined;
  }

  get snapshot(): ArtifactViewingReport {
    const fullscreen = this.surfaces.findLast((surface) => surface.entry.surface === "fullscreen");
    // A fullscreen surface covers other artifact views in this window.
    const shown = fullscreen ? [fullscreen] : this.surfaces;
    const visible = [
      ...new Map(shown.map(({ entry }) => [JSON.stringify(entry), { ...entry }])).values(),
    ];
    const active =
      fullscreen ??
      shown.find((surface) => surface.id === this.activeId) ??
      shown.findLast((surface) => surface.entry.surface !== "inline");
    return active ? { visible, active: { ...active.entry } } : { visible };
  }
}
