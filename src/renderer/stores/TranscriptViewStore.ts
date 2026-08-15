import { Store } from "r-state-tree";

/** Reusable view state for a chat transcript. */
export class TranscriptViewStore extends Store<Record<string, never>> {
  thinkingExpanded = false;

  setThinkingExpanded(expanded: boolean) { this.thinkingExpanded = expanded; }
  toggleThinking() { this.thinkingExpanded = !this.thinkingExpanded; }
}
