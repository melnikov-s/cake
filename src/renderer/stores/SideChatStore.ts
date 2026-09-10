import { Store } from "r-state-tree";
import type { ChatStore } from "./ChatStore";

export interface SideChatTarget {
  readonly key: string;
  readonly title: string;
  readonly eyebrow: () => string;
  readonly chatStore: ChatStore;
}

export interface SideChatStoreProps {
  onClose?(): void;
}

/** Owns one session's transient secondary-chat selection and drawer width. */
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
