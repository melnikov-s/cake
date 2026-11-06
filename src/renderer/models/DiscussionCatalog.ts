import { Model, child, id, observable } from "r-state-tree";
import { ReviewThread } from "./ReviewThread";
import type { DiscussionThreadMetadata } from "../../contracts/discussion-sessions/discussion-session-data";

/** Focused Cake-owned Discussion/review projection for one Project Session. */
export class DiscussionCatalog extends Model {
  @id sessionId = "";
  @child(ReviewThread) threads: ReviewThread[] = observable([]);
  /** Ownership/labels for cold navigation; never a replacement sidecar transcript. */
  metadataLoaded = false;
  metadata: DiscussionThreadMetadata[] = observable([]);
}
