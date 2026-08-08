import { Store, child, createStore, mount } from "r-state-tree";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import type { SessionModel } from "../models/session";
import { DesktopClientContext, SessionContext } from "./context";
import { WindowStore } from "./window-store";

export class RootStore extends Store<{ client: DesktopClient; session: SessionModel }> {
  [DesktopClientContext.provide]() {
    return this.props.client;
  }

  [SessionContext.provide]() {
    return this.props.session;
  }

  get client() {
    const client = DesktopClientContext.consume(this);
    if (!client) throw new Error("DesktopClientContext is not provided");
    return client;
  }

  get session() {
    const session = SessionContext.consume(this);
    if (!session) throw new Error("SessionContext is not provided");
    return session;
  }

  @child
  get windowStore() {
    return createStore(WindowStore);
  }

  constructor(props: RootStore["props"]) {
    super(props);
    this.effect(() => this.client.subscribe((event) => this.receive(event)));
    this.effect(() => () => this.session[Symbol.dispose]());
  }

  private receive(event: DesktopClientEvent) {
    if (event.type === "session-snapshot-received") {
      const previousSessionId = this.session.loaded ? this.session.sessionId : undefined;
      if (!this.windowStore.acceptSessionSnapshot(event)) return;
      this.session.applySnapshot(event.snapshot);
      this.windowStore.applySessionSnapshot(event.snapshot, previousSessionId);
      return;
    }
    if (event.type === "part-updated") {
      if (event.sessionId === this.session.sessionId) this.session.upsertPart(event.part);
      return;
    }
    if (event.type === "part-removed") {
      if (event.sessionId === this.session.sessionId) this.session.removePart(event.partId);
      return;
    }
    if (event.type === "streaming-changed") {
      if (event.sessionId === this.session.sessionId) this.session.setStreaming(event.streaming);
      return;
    }
    this.windowStore.receive(event);
  }
}

export function mountRootStore(client: DesktopClient, session: SessionModel) {
  return mount(createStore(RootStore, { client, session }));
}
