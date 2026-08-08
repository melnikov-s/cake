import { Store, child, createStore, mount } from "r-state-tree";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import { SessionModel } from "../models/session";
import { WindowStore } from "./window-store";

export class RootStore extends Store<{ client: DesktopClient }> {
  session = SessionModel.create();

  @child
  get windowStore() {
    return createStore(WindowStore, { client: this.props.client, session: this.session });
  }

  constructor(props: RootStore["props"]) {
    super(props);
    this.effect(() => this.props.client.subscribe((event) => this.receive(event)));
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

export function mountRootStore(client: DesktopClient) {
  return mount(createStore(RootStore, { client }));
}
