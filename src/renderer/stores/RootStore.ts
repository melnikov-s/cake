import { Store, child, createStore, mount } from "r-state-tree";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import { DesktopClientContext, SessionCacheContext } from "./StoreContext";
import { SessionCacheStore } from "./SessionCacheStore";
import { MainChatStore } from "./MainChatStore";

export class RootStore extends Store<{ client: DesktopClient }> {
  [DesktopClientContext.provide]() {
    return this.props.client;
  }

  [SessionCacheContext.provide]() {
    return this.sessionCache;
  }

  get client() {
    const client = DesktopClientContext.consume(this);
    if (!client) throw new Error("DesktopClientContext is not provided");
    return client;
  }

  @child
  get sessionCache() {
    return createStore(SessionCacheStore);
  }

  @child
  get mainChatStore() {
    return createStore(MainChatStore);
  }

  constructor(props: RootStore["props"]) {
    super(props);
    this.effect(() => this.client.subscribe((event) => this.receive(event)));
  }

  private receive(event: DesktopClientEvent) {
    if (event.type === "session-snapshot-received") {
      const previousSessionId = this.mainChatStore.session?.sessionId;
      if (event.operationId && !this.mainChatStore.acceptSessionSnapshot(event)) return;
      const previous = this.sessionCache.find(event.snapshot.sessionId, event.snapshot.workspacePath);
      const wasStreaming = previous?.streaming ?? false;
      this.sessionCache.upsert(event.snapshot);
      this.mainChatStore.updateSessionActivity(event.snapshot.workspacePath, event.snapshot.sessionId, event.snapshot.streaming, wasStreaming);
      this.mainChatStore.reconcilePendingUserMessages(event.snapshot.sessionId);
      if (event.operationId || this.mainChatStore.isActiveSession(event.snapshot.workspacePath, event.snapshot.sessionId)) {
        this.mainChatStore.applySessionSnapshot(event.snapshot, event.operationId ? previousSessionId : undefined);
      }
      return;
    }
    if (event.type === "part-updated") {
      this.sessionCache.find(event.sessionId)?.upsertPart(event.part);
      this.mainChatStore.reconcilePendingUserMessages(event.sessionId);
      return;
    }
    if (event.type === "part-removed") {
      this.sessionCache.find(event.sessionId)?.removePart(event.partId);
      return;
    }
    if (event.type === "streaming-changed") {
      const session = this.sessionCache.find(event.sessionId);
      const wasStreaming = session?.streaming ?? false;
      session?.setStreaming(event.streaming);
      if (session) this.mainChatStore.updateSessionActivity(session.workspacePath, event.sessionId, event.streaming, wasStreaming);
      return;
    }
    if (event.type === "artifact-updated" || event.type === "artifact-requested") {
      this.sessionCache.find(event.record.artifact.sessionId, event.record.workspacePath)?.upsertArtifact(event.record);
      if (event.type === "artifact-updated") return;
    }
    if (event.type === "review-threads-received") {
      this.sessionCache.applyReviewThreads(event.workspacePath, event.sessionId, event.threads);
      this.mainChatStore.receive(event);
      return;
    }
    if (event.type === "review-thread-updated") {
      this.sessionCache.upsertReviewThread(event.thread);
      this.mainChatStore.receive(event);
      return;
    }
    this.mainChatStore.receive(event);
  }
}

export function mountRootStore(client: DesktopClient) {
  return mount(createStore(RootStore, { client }));
}
