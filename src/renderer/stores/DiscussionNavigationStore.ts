import { Store, child, createStore, snapshot, effect as reactiveEffect } from "r-state-tree";
import type { ModelPreset } from "../../contracts/conversations/session-contract";
import type {
  ConversationNavigationMetadataTarget,
  ConversationNavigationEntry,
  ConversationNavigationTarget,
} from "../lib/conversation-navigation-tree";
import type { RootProjection } from "../models/RootProjection";
import { ClientContext } from "./context/ClientContext";
import { DiscussionSessionStore } from "./DiscussionSessionStore";
import { SubagentActivityStore } from "./SubagentActivityStore";
import type { SideChatStore } from "./SideChatStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

type PrimaryTarget = Extract<
  ConversationNavigationTarget,
  { kind: "cake-chat" | "project-session" }
>;
interface RetainedDiscussion {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly threadId: string;
  readonly workingDirectory: string;
  readonly nested: boolean;
}

/** Materializes existing public Discussion destinations. Selected identity stays in the displayed SideChat target. */
export class DiscussionNavigationStore extends Store<{
  projection: RootProjection;
  operations: SessionOperationCoordinatorStore;
  lineage(target: ConversationNavigationTarget): readonly ConversationNavigationEntry[];
  openPrimary(target: PrimaryTarget): Promise<void>;
  primarySideChat(sessionId: string): SideChatStore | undefined;
  directDiscussion(sessionId: string): DiscussionSessionStore | undefined;
  activeOwnerSessionId(): string | undefined;
  modelPresets(): readonly ModelPreset[];
  openModelPresetSettings(): void;
}> {
  @snapshot private retained: readonly RetainedDiscussion[] = [];
  private openingRevision = 0;

  /** Full child catalogs for visited Discussion owners, not primary-runtime acquisition. */
  get ownerTargets(): readonly ConversationNavigationMetadataTarget[] {
    return this.retained.map((target) => ({
      sessionId: target.sessionId,
      workingDirectory: target.workingDirectory,
      kind: "side-chat",
    }));
  }

  /** Existing full thread records whose actual sidecar conversations should be observed. */
  get discussionTargets() {
    return this.retained.flatMap((target) => {
      const thread = this.props.projection
        .discussionCatalog(target.parentSessionId)
        .threads.find(
          (thread) => thread.id === target.threadId && thread.sidecarSessionId === target.sessionId,
        );
      return thread ? [thread] : [];
    });
  }

  @child
  get sessions(): DiscussionSessionStore[] {
    return this.discussionTargets
      .filter(
        (thread) =>
          this.retained.find((target) => target.sessionId === thread.sidecarSessionId)?.nested,
      )
      .map((thread) =>
        createStore(DiscussionSessionStore, {
          key: thread.sidecarSessionId!,
          thread,
          model: this.props.projection.discussionConversation(
            thread.sidecarSessionId!,
            thread.workingDirectory,
            thread.parentSessionId,
          ),
          operations: this.props.operations,
          modelPresets: this.props.modelPresets,
          openModelPresetSettings: this.props.openModelPresetSettings,
          setResolved: async (resolved) => {
            await ClientContext.consume(this)!.discussionSessions.setResolved(
              {
                parentSessionId: thread.parentSessionId,
                threadId: thread.id,
                workingDirectory: thread.workingDirectory,
                resolved,
              },
              { signal: this.signal },
            );
            return !this.signal.aborted;
          },
        }),
      );
  }

  @child
  get subagents(): SubagentActivityStore[] {
    return this.retained.map((target) =>
      createStore(SubagentActivityStore, {
        key: target.sessionId,
        sessionId: target.sessionId,
        model: this.props.projection.subagentCatalog(target.sessionId),
        parts: () =>
          this.props.projection.discussionConversation(
            target.sessionId,
            target.workingDirectory,
            target.parentSessionId,
          ).uiParts,
      }),
    );
  }

  get sessionIds(): readonly string[] {
    return [
      ...new Set(
        this.props.projection.discussionCatalogs.flatMap((catalog) =>
          [...catalog.threads, ...catalog.metadata].flatMap((thread) =>
            thread.sidecarSessionId ? [thread.sidecarSessionId] : [],
          ),
        ),
      ),
    ];
  }

  targetForSession(
    sessionId: string,
  ): Extract<ConversationNavigationTarget, { kind: "side-chat" }> | undefined {
    for (const catalog of this.props.projection.discussionCatalogs) {
      const thread = [...catalog.threads, ...catalog.metadata].find(
        (thread) => thread.sidecarSessionId === sessionId,
      );
      if (thread)
        return {
          kind: "side-chat",
          sessionId,
          parentSessionId: thread.parentSessionId,
          threadId: thread.id,
        };
    }
    return undefined;
  }

  session(sessionId: string) {
    return (
      this.props.directDiscussion(sessionId) ??
      this.sessions.find((session) => session.sessionId === sessionId)
    );
  }

  cancelOpening() {
    this.openingRevision += 1;
  }

  async open(target: ConversationNavigationTarget): Promise<void> {
    const revision = ++this.openingRevision;
    const lineage = this.props.lineage(target);
    const primary = lineage.findLast(
      (node) => node.target.kind === "cake-chat" || node.target.kind === "project-session",
    );
    if (
      !primary ||
      (primary.target.kind !== "cake-chat" && primary.target.kind !== "project-session")
    )
      throw new Error("The conversation's owning Session is unavailable");
    this.retainLineage(lineage);
    await this.props.openPrimary(primary.target);
    if (revision !== this.openingRevision) return;
    const panel = this.props.primarySideChat(primary.target.sessionId);
    if (!panel || this.props.activeOwnerSessionId() !== primary.target.sessionId) return;
    const previousTarget = panel.target;
    const current = () =>
      revision === this.openingRevision &&
      this.props.activeOwnerSessionId() === primary.target.sessionId &&
      panel.target === previousTarget;
    const title = lineage.at(-1)?.title ?? "Conversation";
    if (target.kind === "side-chat") {
      const session = await this.waitFor(() => this.session(target.sessionId), revision);
      if (!session || !current()) return;
      const parent =
        target.parentSessionId === primary.target.sessionId
          ? undefined
          : await this.waitFor(() => this.session(target.parentSessionId), revision);
      if (!current()) return;
      panel.open({
        key: `discussion:${target.threadId}`,
        navigationTarget: target,
        title,
        chatStore: session.chatStore,
        parentChatStore: parent?.chatStore,
      });
      return;
    }
    if (target.kind === "subagent") {
      const workers = this.subagents.find(
        (workers) => workers.parentSessionId === target.sessionId,
      );
      if (!workers) throw new Error("The subagent's Discussion owner is unavailable");
      await workers.ready();
      if (!current()) return;
      const chatStore = workers.chatStore(target.handleId);
      if (!chatStore)
        throw new Error("The retained public subagent handle has no conversation mapping");
      panel.open({
        key: `subagent:${target.handleId}`,
        navigationTarget: target,
        title,
        eyebrow: () => `Subagent · ${workers.run(target.handleId)?.status ?? "unavailable"}`,
        model: () => workers.model(target.handleId),
        chatStore,
      });
    }
  }

  private retainLineage(lineage: readonly ConversationNavigationEntry[]) {
    for (let index = 0; index < lineage.length; index += 1) {
      const target = lineage[index]!.target;
      if (
        target.kind !== "side-chat" ||
        this.retained.some((retained) => retained.sessionId === target.sessionId)
      )
        continue;
      const catalog = this.props.projection.discussionCatalog(target.parentSessionId);
      const record =
        catalog.threads.find(
          (thread) => thread.id === target.threadId && thread.sidecarSessionId === target.sessionId,
        ) ??
        catalog.metadata.find(
          (thread) => thread.id === target.threadId && thread.sidecarSessionId === target.sessionId,
        );
      if (!record) throw new Error("The Discussion Session ownership record is unavailable");
      this.retained = [
        ...this.retained,
        {
          sessionId: target.sessionId,
          parentSessionId: target.parentSessionId,
          threadId: target.threadId,
          workingDirectory: record.workingDirectory,
          nested: lineage[index - 1]?.target.kind === "side-chat",
        },
      ];
    }
  }

  private waitFor<Value>(
    read: () => Value | undefined,
    revision: number,
  ): Promise<Value | undefined> {
    return new Promise((resolve) => {
      let finished = false;
      const finish = (value: Value | undefined) => {
        if (finished) return;
        finished = true;
        this.signal.removeEventListener("abort", abort);
        stop();
        resolve(value);
      };
      const abort = () => finish(undefined);
      const stop = reactiveEffect(() => {
        const value = read();
        if (this.signal.aborted || revision !== this.openingRevision || value)
          queueMicrotask(() =>
            finish(revision === this.openingRevision && !this.signal.aborted ? value : undefined),
          );
      });
      this.signal.addEventListener("abort", abort, { once: true });
    });
  }
}
