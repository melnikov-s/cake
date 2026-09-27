import { Store } from "r-state-tree";

export interface BrowserMenuItem {
  label: string;
  action?: string;
  disabled?: boolean;
  run?: () => void | Promise<void>;
}

/** A tab-local device menu resolves its original Client command only when the user chooses. */
export class BrowserMenuStore extends Store {
  title = "";
  items: BrowserMenuItem[] = [];
  open = false;
  error: string | undefined;
  private resolve?: (action: string | undefined) => void;

  show(title: string, items: BrowserMenuItem[]): Promise<string | undefined> {
    this.close();
    this.error = undefined;
    this.title = title;
    this.items = items;
    this.open = true;
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  async choose(item: BrowserMenuItem) {
    if (item.disabled) return;
    try {
      await item.run?.();
      this.close(item.action);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  close(action?: string) {
    this.resolve?.(action);
    this.resolve = undefined;
    this.open = false;
    this.items = [];
  }
}
