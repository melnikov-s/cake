import { Store } from "r-state-tree";
import { isCakeChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
import {
  launchedSessions,
  launchedSessionStatus,
  type LaunchedSession,
} from "../lib/cake-chat-launches";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionMetadataStore } from "./SessionMetadataStore";
import { ToastContext } from "./context/ToastContext";

/** Joins delegated Project Session activity without observing or copying their transcripts. */
export class ConversationActivityStore extends Store<{
  catalog: SessionCatalogStore;
  metadata(): SessionMetadataStore;
  openSession(sessionId: string): Promise<void>;
  selectedSessionId?(): string | undefined;
}> {
  private readonly loading = new Set<string>();

  constructor(props: ConversationActivityStore["props"]) {
    super(props);
    // Workflow cards demand only their selected owner’s launched children, not the
    // all-project list. Their activity continues to come from background signals.
    this.effect(() => {
      const owner = this.props.selectedSessionId?.();
      if (!owner) return;
      for (const session of this.props.catalog.backgroundSessions) {
        const launched =
          "cakeChatLaunch" in session && session.cakeChatLaunch?.requesterSessionId === owner;
        const child = session.familyParentSessionId === owner && session.sessionId !== owner;
        if ((launched || child) && !this.props.catalog.find(session.sessionId))
          void this.loadDetails(session.sessionId);
      }
    });
  }

  private async loadDetails(sessionId: string) {
    if (this.loading.has(sessionId)) return;
    this.loading.add(sessionId);
    try {
      await this.props.catalog.lookup(sessionId);
    } catch (error) {
      if (!this.signal.aborted)
        ToastContext.consume(this)?.show({
          tone: "error",
          title: "Could not load delegated session",
          message: error instanceof Error ? error.message : String(error),
          coalesceKey: `delegated-session:${sessionId}`,
          action: { label: "Retry", run: () => this.loadDetails(sessionId) },
        });
    } finally {
      this.loading.delete(sessionId);
    }
  }
  sessionsFor(sessionId: string): LaunchedSession[] {
    const activity = (id: string) => this.props.metadata().sessionActivity(id);
    if (isCakeChatSessionId(sessionId))
      return launchedSessions(this.props.catalog.sessions, activity, sessionId);
    return this.props.catalog.sessions
      .filter(
        (session) =>
          session.sessionId !== sessionId &&
          session.familyParentSessionId === sessionId &&
          !session.resolved,
      )
      .map((session) => ({
        sessionId: session.sessionId,
        title: session.title,
        projectName: session.projectName,
        status: launchedSessionStatus(session, activity(session.sessionId)),
      }));
  }

  async openSession(sessionId: string) {
    try {
      await this.props.openSession(sessionId);
    } catch (error) {
      ToastContext.consume(this)!.show({
        tone: "error",
        title: "Could not open session",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
