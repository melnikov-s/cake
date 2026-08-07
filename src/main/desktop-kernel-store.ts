import { Store, createStore, mount } from "r-state-tree";

export class DesktopKernelStore extends Store {
  readonly process = "main" as const;
}

export function mountDesktopKernelStore() {
  return mount(createStore(DesktopKernelStore));
}
