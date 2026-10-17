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
}> {
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
