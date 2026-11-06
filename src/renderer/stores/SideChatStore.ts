import { Store } from "r-state-tree";
import type { ArtifactMenuStore } from "./ArtifactMenuStore";
import type { ThinkingLevel } from "../../contracts/conversations/session-contract";
import type { SideChatMergeStore } from "./SideChatMergeStore";
import type { ChatStore } from "./ChatStore";
import type { ConversationNavigationTarget } from "../lib/conversation-navigation-tree";
import type { SessionChangesStore } from "./SessionChangesStore";

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
  /** Public identity of the actual focused conversation; never a worker's private Pi ID. */
  readonly navigationTarget?: ConversationNavigationTarget;
  readonly eyebrow?: () => string;
  readonly model?: () => SideChatModel | undefined;
  readonly merge?: SideChatMergeStore;
}

export type SideChatTarget = SidePanelTarget &
  (
    | {
        readonly chatStore: ChatStore;
        readonly artifact?: never;
        readonly changes?: never;
      }
    | {
        readonly chatStore?: never;
        readonly artifact: ArtifactMenuStore;
        readonly changes?: never;
      }
    | {
        readonly chatStore?: never;
        readonly artifact?: never;
        readonly changes: SessionChangesStore;
      }
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
