import { Store, child, createStore } from "r-state-tree";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import type {
  CapturePreferences,
  CaptureDestination,
} from "../../contracts/desktop/screen-capture-data";
import type { Client } from "../client/Client";
import type { AppShellStore } from "./AppShellStore";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import type { NavigationStore } from "./NavigationStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import { CaptureDestinationPickerStore } from "./CaptureDestinationPickerStore";
import { ToastContext } from "./context/ToastContext";

/** Window-local quick-chat routing; conversations and their drafts retain their existing owners. */
export class CakeChatOverlayStore extends Store<{
  client: Client["electron"];
  shell: AppShellStore;
  catalog: SessionCatalogStore;
  registry: SessionRegistryStore;
  cakeChat(): CakeChatCollectionStore;
  navigation(): NavigationStore;
  routing(): Omit<CapturePreferences, "defaultDestination">;
}> {
  get invocationSessionId() {
    const selection = this.props.shell.selection;
    if (selection.kind !== "project-session") return CAKE_CHAT_SESSION_ID;
    const workspace =
      this.props.catalog.find(selection.sessionId)?.workingDirectory ??
      this.props.registry.findSession(selection.sessionId)?.workspacePath;
    if (!workspace) return CAKE_CHAT_SESSION_ID;
    const projectPath = this.props.catalog.projectPathFor(workspace) ?? workspace;
    return this.props.cakeChat().projectChat(projectPath)?.sessionId ?? CAKE_CHAT_SESSION_ID;
  }

  async request() {
    try {
      await this.props.client.showCakeChatOverlay(this.invocationSessionId);
    } catch (error) {
      this.report(error);
    }
  }

  async resize(height: number) {
    try {
      await this.props.client.resizeCakeChatOverlay(Math.round(height), { signal: this.signal });
    } catch (error) {
      this.report(error, "Could not resize drop-down Cake Chat");
    }
  }

  async dismiss() {
    try {
      await this.props.client.hideCakeChatOverlay({ signal: this.signal });
    } catch (error) {
      this.report(error, "Could not close drop-down Cake Chat");
    }
  }

  @child get destinationPicker(): CaptureDestinationPickerStore {
    const routing = () => this.props.routing();
    return createStore(CaptureDestinationPickerStore, {
      get routing() {
        return routing();
      },
      currentDestination: () => {
        const selection = this.props.shell.selection;
        return selection.kind === "cake-chat" && selection.sessionId
          ? { kind: "cake-chat", sessionId: selection.sessionId }
          : undefined;
      },
      onSelect: (destination) => void this.select(destination),
    });
  }

  private async select(destination: CaptureDestination) {
    try {
      if (destination.kind === "cake-chat")
        await this.props.navigation().openCakeChat(destination.sessionId);
      else
        // Project Session destinations keep the overlay's existing main-window handoff policy.
        await this.props.navigation().openSession(destination.sessionId);
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown, title = "Could not open quick Cake Chat") {
    if (this.signal.aborted) return;
    ToastContext.consume(this)!.show({
      tone: "error",
      title,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
