import { Store } from "r-state-tree";
import type { ArtifactNavigationContext } from "../../contracts/artifacts/artifact-navigation-context";
import {
  isCakeChatSessionId,
  isProjectChatSessionId,
} from "../../contracts/cake-chats/cake-chat-identity";
import type { Attachment } from "../../contracts/conversations/session-contract";
import type { CapturePreferences } from "../../contracts/desktop/screen-capture-data";
import {
  COMPOSER_ATTACHMENT_LIMIT,
  type WidgetComposerAttachInput,
  type WidgetComposerAttachResult,
  type WidgetComposerTarget,
  type WidgetItemAttachment,
  type WidgetItemOrigin,
} from "../../contracts/widgets/widget-composer-item";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";

/** The chat a widget is shown in: its chat slot, or the main view's selection for global widgets. */
export type WidgetViewSession = ArtifactNavigationContext["session"];

const attachmentCount = (attachments: readonly Attachment[]) =>
  attachments.filter((item) => item.kind !== "annotation").length +
  (attachments.some((item) => item.kind === "annotation") ? 1 : 0);

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Lets a widget place one of its items into a chat's unsent composer draft.
 * It never sends, never navigates, and fills the widget origin from the host.
 * Live drafts persist with the window snapshot; Saved Drafts keep their
 * revision-checked authority.
 */
export class WidgetComposerStore extends Store<{
  registry: SessionRegistryStore;
  cakeChats(): CakeChatCollectionStore;
  destinations(): Pick<CapturePreferences, "projects" | "cakeChats">;
  persist(): Promise<void>;
  workingDirectory(sessionId: string): string | undefined;
}> {
  /** Every editable chat composer in this window, with the widget's current default marked. */
  targets(current: WidgetViewSession): WidgetComposerTarget[] {
    const { projects, cakeChats } = this.props.destinations();
    const mark = (target: WidgetComposerTarget): WidgetComposerTarget =>
      target.sessionId === current?.sessionId ? { ...target, current: true } : target;
    const seen = new Set<string>();
    const targets: WidgetComposerTarget[] = [];
    const add = (target: WidgetComposerTarget) => {
      if (seen.has(target.sessionId)) return;
      seen.add(target.sessionId);
      targets.push(mark(target));
    };
    for (const chat of cakeChats)
      add({
        sessionId: chat.sessionId,
        kind: isProjectChatSessionId(chat.sessionId) ? "project-chat" : "cake-chat",
        title: chat.title,
      });
    for (const project of projects) {
      const location = { projectPath: project.path, projectName: project.name };
      if (project.chatSessionId)
        add({
          sessionId: project.chatSessionId,
          kind: "project-chat",
          title: project.name,
          ...location,
        });
      for (const session of project.sessions)
        add({
          sessionId: session.sessionId,
          kind: "project-session",
          title: session.title,
          ...location,
        });
    }
    return targets;
  }

  async attach(
    origin: WidgetItemOrigin,
    request: WidgetComposerAttachInput,
    current: WidgetViewSession,
  ): Promise<WidgetComposerAttachResult> {
    const sessionId = request.sessionId ?? current?.sessionId;
    if (!sessionId)
      return {
        ok: false,
        error: "No chat is selected. Open a chat or pass sessionId from cake.composer.targets().",
      };
    const target = this.targets(current).find((item) => item.sessionId === sessionId);
    if (!target)
      return {
        ok: false,
        error:
          request.sessionId === undefined && current?.kind === "automation-session"
            ? "Automation sessions have no composer. Pass sessionId from cake.composer.targets()."
            : `No editable chat composer has session ID ${sessionId}. Use cake.composer.targets() to list them.`,
      };
    // Origin comes from the rendering widget, never from the request payload.
    const item: WidgetItemAttachment = {
      kind: "widget-item",
      name: request.label,
      itemId: request.itemId,
      widget: { ...origin },
      ...(request.data !== undefined ? { data: request.data } : null),
    };
    try {
      return await this.append(target, item);
    } catch (error) {
      return { ok: false, target, error: errorMessage(error) };
    }
  }

  private async append(
    target: WidgetComposerTarget,
    item: WidgetItemAttachment,
  ): Promise<WidgetComposerAttachResult> {
    const draft = this.composer(target).draftStore;
    const pending = this.props.registry.pendingSessions;
    const saved =
      target.kind === "project-session" ? pending.savedRecord(target.sessionId) : undefined;
    if (saved && saved.status !== "saved")
      return { ok: false, target, error: "That draft is being started; try again shortly." };
    const existing = [...(saved?.attachments ?? []), ...draft.submissionAttachments];
    if (
      existing.some(
        (attachment) =>
          attachment.kind === "widget-item" &&
          attachment.widget.lineageId === item.widget.lineageId &&
          attachment.itemId === item.itemId,
      )
    )
      return { ok: true, target, duplicate: true, sent: false };
    if (attachmentCount(existing) >= COMPOSER_ATTACHMENT_LIMIT)
      return {
        ok: false,
        target,
        error: `That composer already has ${COMPOSER_ATTACHMENT_LIMIT} attachments. Remove one first.`,
      };
    if (saved) {
      await pending.updateDraft(target.sessionId, saved.text, [...saved.attachments, item]);
      return { ok: true, target, duplicate: false, sent: false };
    }
    draft.appendAttachments([item]);
    try {
      await this.props.persist();
    } catch (error) {
      return {
        ok: true,
        target,
        duplicate: false,
        sent: false,
        warning: `Added to the draft, but the window state could not be saved: ${errorMessage(error)}`,
      };
    }
    return { ok: true, target, duplicate: false, sent: false };
  }

  /** Loads the destination composer without navigating or opening its runtime. */
  private composer(target: WidgetComposerTarget) {
    if (isCakeChatSessionId(target.sessionId))
      return this.props.cakeChats().registry.load(target.sessionId).conversationSessionStore
        .composerStore;
    const loaded = this.props.registry.findSession(target.sessionId);
    if (loaded) return loaded.conversationSessionStore.composerStore;
    const directory = this.props.workingDirectory(target.sessionId);
    if (!directory) throw new Error("That session is no longer editable.");
    return this.props.registry.load(target.sessionId, directory).conversationSessionStore
      .composerStore;
  }
}
