import { Store } from "r-state-tree";

/** Owns the ephemeral, window-scoped workflow for keyboard-driven UI target selection. */
export class UiHintModeStore extends Store {
  active = false;
  prefix = "";

  toggle() {
    if (this.active) this.close();
    else this.open();
  }

  open() {
    this.prefix = "";
    this.active = true;
  }

  close() {
    this.active = false;
    this.prefix = "";
  }

  append(key: string) {
    this.prefix += key.toLowerCase();
  }

  removeLast() {
    this.prefix = this.prefix.slice(0, -1);
  }
}
