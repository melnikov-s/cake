import { Model } from "r-state-tree";
import type { CanvasCard, CanvasSnapshot } from "../../contracts/project-canvas/project-canvas";

export class ProjectCanvas extends Model {
  cards: readonly CanvasCard[] = [];

  replace(snapshot: CanvasSnapshot) {
    this.cards = snapshot.cards;
  }
}
