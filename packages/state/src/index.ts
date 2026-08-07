import { Store, createStore, mount } from "r-state-tree";

export const cakeStateVersion = 1;

export class DesktopKernelStore extends Store {
  readonly process = "main" as const;
}

export class WindowStore extends Store {
  readonly process = "renderer" as const;
}

export function mountDesktopKernelStore() {
  return mount(createStore(DesktopKernelStore));
}

export function mountWindowStore() {
  return mount(createStore(WindowStore));
}
