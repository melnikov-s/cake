import { reaction } from "r-state-tree";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-data";
import type { CakeChatOverlayShownContext } from "../../contracts/desktop/cake-chat-overlay-data";
import type { AppSelection } from "../stores/AppShellStore";
import type { RootStore } from "../stores/RootStore";

/**
 * The drop-down overlay presents only Cake Chat conversations. Any other destination, such as
 * a session opened by a link or by a Cake Chat navigation control, belongs in a main window.
 * Returns undefined when the overlay keeps the selection.
 */
export function cakeChatOverlayHandoff(
  selection: AppSelection,
): { readonly sessionId?: string } | undefined {
  if (selection.kind === "cake-chat") return undefined;
  return selection.kind === "project-session" ? { sessionId: selection.sessionId } : {};
}

/** Starts an overlay renderer on the permanent Cake Chat and keeps it there. */
export function startCakeChatOverlay(root: RootStore) {
  // Cake Chat controls bind to the window that last sent a prompt, so the overlay must be able
  // to answer them just like a main window.
  root.applicationControlStore.start();
  root.screenCaptureStore.cakeChatOnly = true;
  // The selection lands synchronously, before the handoff observer starts watching.
  const opening = root.navigationStore.openCakeChat(CAKE_CHAT_SESSION_ID);
  reaction(
    () => root.appShellStore.selection,
    (selection) => {
      const handoff = cakeChatOverlayHandoff(selection);
      if (!handoff) return;
      void root.client.electron.showMainWindow(handoff.sessionId).catch((error: unknown) =>
        root.toastStore.show({
          tone: "error",
          title: "Could not open the main Cake window",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      void root.navigationStore.openCakeChat(CAKE_CHAT_SESSION_ID);
    },
  );
  return opening;
}

/**
 * Attaches the context main gathered before a drop-down to the Cake Chat draft as an ordinary
 * removable text attachment, or explains why none could be read. The first drop-down may
 * arrive before the conversation finishes opening, so this waits for it.
 */
export async function receiveCakeChatOverlayContext(
  root: RootStore,
  context: CakeChatOverlayShownContext,
) {
  if (context.notice)
    root.toastStore.show({
      tone: "warning",
      title: "Selected text unavailable",
      message: context.notice,
      coalesceKey: "cake-chat-overlay-selected-text",
    });
  const selected = context.selectedText;
  if (!selected) return;
  await root.navigationStore.openCakeChat(CAKE_CHAT_SESSION_ID);
  const draft =
    root.cakeChatCollectionStore.registry.find(CAKE_CHAT_SESSION_ID)?.conversationSessionStore
      .composerStore.draftStore;
  if (!draft) throw new Error("Cake Chat is not available to attach the selected text.");
  draft.addSelectedText(selected.text, selected.application);
}
