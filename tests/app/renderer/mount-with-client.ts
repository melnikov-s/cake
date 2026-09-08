import { Store, child, createStore, mount } from "r-state-tree";
import type { Client } from "../../../src/renderer/client/Client";
import { ClientContext } from "../../../src/renderer/stores/context/ClientContext";

class ClientTestStore extends Store<{
  client: Client;
  subject: Store;
}> {
  [ClientContext.provide]() {
    return this.props.client;
  }

  @child get subject() {
    return this.props.subject;
  }
}

export function mountWithClient<Subject extends Store>(subject: Subject, client: Client) {
  const root = mount(createStore(ClientTestStore, { client, subject }));
  // SAFETY: ClientTestStore returns the exact keyed descriptor supplied by this call.
  return { root, subject: root.subject as Subject };
}
