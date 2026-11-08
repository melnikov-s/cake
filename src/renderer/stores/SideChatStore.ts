import { Store } from "r-state-tree";
import { describeError } from "../lib/error-details";
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
  readonly currentTitle?: () => string;
  /** Public identity of the actual focused conversation; never a worker's private Pi ID. */
  readonly navigationTarget?: ConversationNavigationTarget;
  readonly eyebrow?: () => string;
  readonly model?: () => SideChatModel | undefined;
  readonly merge?: SideChatMergeStore;
  readonly resolve?: () => Promise<boolean>;
}

export type SideChatTarget = SidePanelTarget &
  (
    | {
        readonly chatStore: ChatStore;
        /** Nested discussions show their immediate origin instead of the workspace's primary chat. */
        readonly parentChatStore?: ChatStore;
        readonly artifact?: never;
        readonly changes?: never;
        readonly pending?: never;
      }
    | {
        readonly chatStore?: never;
        readonly artifact: ArtifactMenuStore;
        readonly changes?: never;
        readonly pending?: never;
      }
    | {
        readonly chatStore?: never;
        readonly artifact?: never;
        readonly changes: SessionChangesStore;
        readonly pending?: never;
      }
    | {
        readonly chatStore?: never;
        readonly artifact?: never;
        readonly changes?: never;
        readonly pending: { message(): string; retry?(): void };
      }
  );

export interface SideChatTab {
  readonly id: string;
  readonly title: string;
}

export interface SideChatTabNavigation {
  entries(): readonly SideChatTab[];
  select(threadId: string): void;
}

export interface SideChatStoreProps {
  sessionId?: string;
  tabs?: SideChatTabNavigation;
  onClose?(): void;
}

/** Owns one session’s transient accessory selection and shared secondary-pane width. */
export class SideChatStore extends Store<SideChatStoreProps> {
  target: SideChatTarget | undefined;
  width = 416;
  resolving = false;
  resolutionError: string | undefined;

  /** Direct siblings of the selected chat; artifacts, drafts and private workers are not tabs. */
  get tabs(): readonly SideChatTab[] {
    const target = this.target;
    const navigation = target?.navigationTarget;
    if (
      !target ||
      navigation?.kind !== "side-chat" ||
      navigation.parentSessionId !== this.props.sessionId
    )
      return [];
    const entries = this.props.tabs?.entries() ?? [];
    // An explicitly merged/archived chat can remain open for inspection.
    return entries.some((entry) => entry.id === navigation.threadId)
      ? entries
      : [...entries, { id: navigation.threadId, title: target.currentTitle?.() ?? target.title }];
  }

  selectTab(threadId: string) {
    const navigation = this.target?.navigationTarget;
    if (navigation?.kind !== "side-chat" || navigation.threadId === threadId) return;
    if (this.tabs.some((entry) => entry.id === threadId)) this.props.tabs?.select(threadId);
  }

  open(target: SideChatTarget) {
    this.resolutionError = undefined;
    this.target = target;
  }

  async closeAndResolve() {
    const target = this.target;
    if (!target?.resolve || this.resolving || target.merge?.pending) return;
    this.resolving = true;
    this.resolutionError = undefined;
    try {
      const resolved = await target.resolve();
      if (this.signal.aborted || this.target !== target) return;
      if (resolved) this.close();
      else this.resolutionError = "Could not resolve side chat. Try again.";
    } catch (error) {
      if (!this.signal.aborted && this.target === target)
        this.resolutionError = describeError(error).message;
    } finally {
      this.resolving = false;
    }
  }

  close() {
    this.target = undefined;
    this.props.onClose?.();
  }

  setWidth(width: number) {
    this.width = Math.max(320, width);
  }
}
