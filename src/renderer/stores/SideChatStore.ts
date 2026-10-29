import { Store } from "r-state-tree";
import type { ThinkingLevel } from "../../contracts/conversations/session-contract";
import type { SideChatMergeStore } from "./SideChatMergeStore";
import type { ChatStore } from "./ChatStore";
import type { ProjectTodosStore } from "./ProjectTodosStore";

/** The fixed configuration a side chat's agent runs on; the panel cannot change it. */
export interface SideChatModel {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly fastMode: boolean;
}

interface SidePanelTarget {
  readonly key: string;
  readonly title: string;
  readonly eyebrow?: () => string;
  readonly model?: () => SideChatModel | undefined;
  readonly merge?: SideChatMergeStore;
}

export type SideChatTarget = SidePanelTarget &
  (
    | { readonly chatStore: ChatStore; readonly todos?: never }
    | { readonly chatStore?: never; readonly todos: ProjectTodosStore }
  );

export interface SideChatStoreProps {
  onClose?(): void;
}

/** Owns one session’s transient accessory selection and shared secondary-pane width. */
export class SideChatStore extends Store<SideChatStoreProps> {
  target: SideChatTarget | undefined;
  width = 416;

  open(target: SideChatTarget) {
    this.target = target;
  }

  close() {
    this.target = undefined;
    this.props.onClose?.();
  }

  setWidth(width: number) {
    this.width = Math.max(320, width);
  }
}
