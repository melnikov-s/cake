import { Store, child, createStore, mount } from "r-state-tree";
import type { Client } from "../../../src/renderer/client/Client";
import { ClientContext } from "../../../src/renderer/stores/context/ClientContext";
import { TerminalTopInsetContext } from "../../../src/renderer/stores/context/TerminalTopInsetContext";

class ClientTestStore extends Store<{
  client: Client;
  subject: Store;
  terminalTopInset(): number;
}> {
  [ClientContext.provide]() {
    return this.props.client;
  }

  [TerminalTopInsetContext.provide]() {
    return this.props.terminalTopInset();
  }

  @child get subject() {
    return this.props.subject;
  }
}

export function mountWithClient<Subject extends Store>(
  subject: Subject,
  client: Client,
  terminalTopInset: () => number = () => 0,
) {
  const root = mount(createStore(ClientTestStore, { client, subject, terminalTopInset }));
  // SAFETY: ClientTestStore returns the exact keyed descriptor supplied by this call.
  return { root, subject: root.subject as Subject };
}
