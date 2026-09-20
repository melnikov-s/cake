import { Model, child, id, observable } from "r-state-tree";
import { ReviewThread } from "./ReviewThread";

/** Focused Cake-owned Discussion/review projection for one Project Session. */
export class DiscussionCatalog extends Model {
  @id sessionId = "";
  @child(ReviewThread) threads: ReviewThread[] = observable([]);
  relationshipRevision = 0;
}
