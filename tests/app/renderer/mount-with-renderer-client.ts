import { Store, child, createStore, mount } from "r-state-tree";
import type { RendererClient } from "../../../src/renderer/client/RendererClient";
import { RendererClientContext } from "../../../src/renderer/client/RendererClientContext";

class RendererClientTestStore extends Store<{
  client: RendererClient;
  subject: Store;
}> {
  [RendererClientContext.provide]() {
    return this.props.client;
  }

  @child get subject() {
    return this.props.subject;
  }
}

export function mountWithRendererClient<Subject extends Store>(
  subject: Subject,
  client: RendererClient,
) {
  const root = mount(createStore(RendererClientTestStore, { client, subject }));
  // SAFETY: RendererClientTestStore returns the exact keyed descriptor supplied by this call.
  return { root, subject: root.subject as Subject };
}
