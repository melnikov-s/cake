import { Store } from "r-state-tree";
import type { Attachment } from "../../contracts/conversations/session-contract";
import type {
  CaptureDestination,
  CapturePreferences,
} from "../../contracts/desktop/screen-capture-data";
import type { ComposerDraftStore } from "./ComposerDraftStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import type { NavigationStore } from "./NavigationStore";
import { ToastContext } from "./context/ToastContext";

const capture = (draft: ComposerDraftStore) => {
  // Keep implicit editor context separate so Undo restores its ownership rather
  // than turning it into an explicit attachment.
  const attachments = draft.submissionAttachments;
  return {
    state: {
      text: draft.text,
      attachments: draft.attachments.slice(),
      annotations: draft.annotationDraft.annotations.slice(),
      editorContextAttachment: draft.editorContextAttachment,
    },
    text: draft.text,
    attachments,
  };
};
type DraftCheckpoint = ReturnType<typeof capture>;
const restore = (draft: ComposerDraftStore, checkpoint: DraftCheckpoint) => {
  draft.restore(checkpoint.state.text, checkpoint.state.attachments);
  draft.annotationDraft.append(checkpoint.state.annotations);
  draft.setEditorContextAttachment(checkpoint.state.editorContextAttachment);
};
const unchanged = (draft: ComposerDraftStore, checkpoint: DraftCheckpoint) =>
  !draft.signal.aborted &&
  !draft.pendingImageImports &&
  JSON.stringify(capture(draft).state) === JSON.stringify(checkpoint.state);
const joinText = (left: string, right: string) => [left, right].filter(Boolean).join("\n\n");
const checkLimits = (attachments: readonly Attachment[]) => {
  const annotations = attachments
    .filter((item) => item.kind === "annotation")
    .reduce((count, item) => count + item.annotations.length, 0);
  const count =
    attachments.filter((item) => item.kind !== "annotation").length + (annotations ? 1 : 0);
  if (count > 20 || annotations > 100)
    throw new Error(
      "The combined draft exceeds the 20 attachment or 100 annotation limit. Nothing was moved.",
    );
};

const mergeAttachments = (combined: readonly Attachment[]): Attachment[] => {
  const annotations = combined.flatMap((item) =>
    item.kind === "annotation" ? item.annotations : [],
  );
  return [
    ...combined.filter((item) => item.kind !== "annotation"),
    ...(annotations.length ? [{ kind: "annotation" as const, annotations }] : []),
  ];
};

/** One window's move/Undo workflow. Unsent content stays in the existing composer
 * snapshot; explicit Saved Drafts keep their existing revision-checked authority.
 * Every destructive step follows a successful save and rechecks both live drafts.
 */
export class DraftMoveStore extends Store<{
  registry: SessionRegistryStore;
  cakeChats(): CakeChatCollectionStore;
  navigation(): NavigationStore;
  routing(): Omit<CapturePreferences, "defaultDestination">;
  persist(): Promise<void>;
  workingDirectory(sessionId: string): string | undefined;
}> {
  busy = false;

  destinations(sourceId: string) {
    const routing = this.props.routing();
    return {
      ...routing,
      cakeChats: routing.cakeChats.filter((item) => item.sessionId !== sourceId),
      projects: routing.projects.map((project) => ({
        ...project,
        ...(project.chatSessionId === sourceId ? { chatSessionId: undefined } : null),
        sessions: project.sessions.filter((item) => item.sessionId !== sourceId),
      })),
    };
  }

  private available(destination: CaptureDestination, sourceId: string) {
    const routing = this.destinations(sourceId);
    return destination.kind === "cake-chat"
      ? routing.cakeChats.some((item) => item.sessionId === destination.sessionId)
      : routing.projects.some((project) =>
          project.sessions.some((item) => item.sessionId === destination.sessionId),
        );
  }

  private load(destination: CaptureDestination) {
    if (destination.kind === "cake-chat")
      return this.props.cakeChats().registry.load(destination.sessionId).conversationSessionStore;
    const loaded = this.props.registry.findSession(destination.sessionId);
    if (loaded) return loaded.conversationSessionStore;
    const directory = this.props.workingDirectory(destination.sessionId);
    if (!directory) throw new Error("The destination session is no longer editable.");
    return this.props.registry.load(destination.sessionId, directory).conversationSessionStore;
  }

  /** Withdraw first: the runtime rejects a consumed item. Until that succeeds neither
   * draft is touched. Afterwards the only copy belongs to the destination, even if
   * saving it fails; never report a retryable failure that could forward it twice. */
  async forwardQueued(
    sourceId: string,
    content: { text: string; attachments: readonly Attachment[] },
    destination: CaptureDestination,
    withdraw: () => Promise<void>,
  ): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      if (!this.available(destination, sourceId))
        throw new Error("Choose another editable session.");
      const conversation = this.load(destination);
      const composer = conversation.composerStore;
      const target = composer.draftStore;
      const pending = this.props.registry.pendingSessions;
      const saved =
        destination.kind === "project-session"
          ? pending.savedRecord(destination.sessionId)
          : undefined;
      if (composer.editingMessage)
        throw new Error("Finish editing the destination message before moving a draft.");
      if (target.pendingImageImports)
        throw new Error("Wait for the destination images to finish loading, then try again.");
      if (saved && saved.status !== "saved")
        throw new Error("The destination draft is being activated.");
      checkLimits([
        ...(saved?.attachments ?? []),
        ...target.submissionAttachments,
        ...content.attachments,
      ]);
      await withdraw();

      // No await between confirmed withdrawal and retaining the edited payload.
      // Append to the live draft, not a stale checkpoint or the source composer.
      target.setText(joinText(target.text, content.text));
      target.appendAttachments(content.attachments);
      let warning: string | undefined;
      try {
        if (saved) {
          // Saved Drafts retain their revision-checked persistence authority. Keep
          // the live copy until that save succeeds, so rejection cannot lose input.
          const after = capture(target);
          await pending.updateDraft(
            destination.sessionId,
            joinText(saved.text, after.text),
            mergeAttachments([...saved.attachments, ...after.attachments]),
          );
          if (unchanged(target, after)) target.clearForSubmit();
        }
        await this.props.persist();
      } catch (error) {
        warning = `Message removed from the source queue and kept in the destination draft, but could not be saved: ${error instanceof Error ? error.message : String(error)}. Keep this window open and save the draft before closing.`;
      }
      // Loading above deliberately did not navigate away from an unsaved editor.
      // Ordinary moves still use the same navigation and destination draft owner.
      try {
        await this.open(destination);
      } catch {
        warning ??=
          "Message removed from the source queue and kept in the destination draft. Open that session to review it. Nothing was sent.";
      }
      target.requestFocus({ explicit: true });
      this.notify(
        warning ?? "Open in the destination for review. Nothing was sent.",
        warning ? "warning" : "info",
      );
      return true;
    } finally {
      this.busy = false;
    }
  }

  private async open(destination: CaptureDestination) {
    if (destination.kind === "cake-chat") {
      await this.props.navigation().openCakeChat(destination.sessionId);
      return this.props.cakeChats().registry.find(destination.sessionId)?.conversationSessionStore;
    }
    const loaded = this.props.registry.findSession(destination.sessionId);
    if (loaded) {
      const draft = loaded.conversationSessionStore.composerStore.draftStore;
      const context = draft.editorContextAttachment;
      this.props.navigation().showLoadedProjectSession(destination.sessionId);
      // Leaving an embedded editor suspends its selection context. A move must
      // retain the destination's existing draft, including that context.
      if (context) draft.setEditorContextAttachment(context);
    } else if (!(await this.props.navigation().openSession(destination.sessionId)))
      return undefined;
    return this.props.registry.findSession(destination.sessionId)?.conversationSessionStore;
  }

  private notify(message: string, tone: "info" | "warning" | "error" = "error") {
    ToastContext.consume(this)!.show({ title: "Move draft", message, tone });
  }

  async move(sourceId: string, source: ComposerDraftStore, destination: CaptureDestination) {
    if (this.busy || !source.hasContent) return;
    if (source.pendingImageImports) {
      this.notify("Wait for the draft images to finish loading, then try again.");
      return;
    }
    this.busy = true;
    const from = capture(source);
    try {
      if (!this.available(destination, sourceId))
        throw new Error("Choose another editable session.");
      const conversation = await this.open(destination);
      if (!conversation || !this.available(destination, sourceId))
        throw new Error("The destination session is no longer editable.");
      if (!unchanged(source, from))
        throw new Error("The source draft changed. Nothing was moved; try again.");
      const composer = conversation.composerStore;
      if (composer.editingMessage)
        throw new Error("Finish editing the destination message before moving a draft.");
      const target = composer.draftStore;
      if (target.pendingImageImports)
        throw new Error("Wait for the destination images to finish loading, then try again.");
      if (target === source) throw new Error("Choose another session.");
      const before = capture(target);
      const pending = this.props.registry.pendingSessions;
      const saved =
        destination.kind === "project-session"
          ? pending.savedRecord(destination.sessionId)
          : undefined;
      if (saved && saved.status !== "saved")
        throw new Error("The destination draft is being activated.");
      const text = joinText(joinText(saved?.text ?? "", before.text), from.text);
      const combined = [...(saved?.attachments ?? []), ...before.attachments, ...from.attachments];
      const attachments = mergeAttachments(combined);
      checkLimits(attachments);

      // Saved Draft updates use their existing compare-and-swap revision. Ordinary
      // composers are already hydrated; never reload disk state over a live draft.
      let savedRevision: number | undefined;
      let after: DraftCheckpoint;
      if (saved) {
        await pending.updateDraft(destination.sessionId, text, attachments);
        savedRevision = saved.revision + 1;
        if (
          !unchanged(target, before) ||
          pending.savedRecord(destination.sessionId)?.revision !== savedRevision
        ) {
          this.notify(
            "The destination changed while saving. The source was kept; review both drafts.",
            "warning",
          );
          return;
        }
        target.clearForSubmit();
        after = capture(target);
        await this.props.persist();
      } else {
        // Append via the ordinary attachment owner, including annotation bundles.
        target.setText(text);
        target.appendAttachments(from.attachments);
        after = capture(target);
        try {
          await this.props.persist();
        } catch (error) {
          if (unchanged(target, after)) restore(target, before);
          throw error;
        }
      }
      const destinationUnchanged = () =>
        this.available(destination, sourceId) &&
        unchanged(target, after) &&
        (savedRevision === undefined ||
          pending.savedRecord(destination.sessionId)?.revision === savedRevision);
      if (!unchanged(source, from) || !destinationUnchanged()) {
        this.notify(
          "A draft changed while saving. The destination was saved and the source was kept; review both drafts.",
          "warning",
        );
        return;
      }
      source.clearForSubmit();
      const cleared = capture(source);
      let cleanupFailed = false;
      try {
        await this.props.persist();
      } catch {
        // Destination is durable. A failed source cleanup may leave a duplicate
        // after reload, never the only copy erased before its destination exists.
        cleanupFailed = true;
      }
      target.requestFocus({ explicit: true });
      ToastContext.consume(this)!.show({
        title: "Draft moved",
        message: cleanupFailed
          ? "Destination saved. Source cleanup could not be saved; a copy may remain after reload."
          : "Open in the destination for review. Nothing was sent.",
        tone: cleanupFailed ? "warning" : "info",
        autoDismiss: false,
        action: {
          label: "Undo",
          run: async () => {
            if (this.busy) return;
            this.busy = true;
            try {
              if (!unchanged(source, cleared) || !destinationUnchanged())
                throw new Error(
                  "Cannot undo because a draft changed. Both drafts were left untouched.",
                );
              // Restore and save the source FIRST. If this fails, retain destination.
              restore(source, from);
              const restored = capture(source);
              await this.props.persist();
              if (!unchanged(source, restored) || !destinationUnchanged())
                throw new Error(
                  "A draft changed during Undo. The source copy was restored; the destination was kept.",
                );
              if (saved) {
                await pending.updateDraft(destination.sessionId, saved.text, [
                  ...saved.attachments,
                ]);
                if (!unchanged(target, after))
                  throw new Error("The destination changed during Undo. Its new edits were kept.");
              }
              restore(target, before);
              await this.props.persist();
              source.requestFocus({ explicit: true });
              this.notify("Draft restored. Nothing was sent.", "info");
            } catch (error) {
              this.notify(error instanceof Error ? error.message : String(error));
            } finally {
              this.busy = false;
            }
          },
        },
      });
    } catch (error) {
      this.notify(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
    }
  }
}
