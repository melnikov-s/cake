import { Store } from "r-state-tree";

/** Transient rail occlusion for native views, not navigation or persisted layout. */
export class ProjectRailStore extends Store {
  overlayRight = 0;
  revealed = false;

  setRevealed(revealed: boolean) {
    this.revealed = revealed;
  }

  setOverlayRight(right: number) {
    this.overlayRight = right;
  }
}
