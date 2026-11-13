import { Store, observable } from "r-state-tree";
import type {
  CaptureDestination,
  CapturePreferences,
  CaptureSessionOption,
} from "../../contracts/desktop/screen-capture-data";

/** One native capture's destination and disclosures. No catalog observations or sidebar UI state. */
export class CaptureDestinationPickerStore extends Store<{
  routing(): Omit<CapturePreferences, "defaultDestination">;
  /** Captured once, independently of the lazy destination catalog. */
  initialDestination?: CaptureDestination;
  currentDestination?(): CaptureDestination | undefined;
  onSelect?(destination: CaptureDestination): void;
}> {
  private selectedDestination: CaptureDestination | undefined = this.props.initialDestination;

  get destination() {
    return this.props.currentDestination
      ? this.props.currentDestination()
      : this.selectedDestination;
  }
  /** Explicit project toggles; untouched projects follow `selectedProjectPath`. Retained for this store's lifetime. */
  private readonly projectExpansion = observable(new Map<string, boolean>());
  private readonly collapsedFamilies = observable(new Set<string>());

  get routing() {
    return this.props.routing();
  }

  get label() {
    const destination = this.destination;
    return (
      [...this.routing.cakeChats, ...this.routing.projects.flatMap((p) => p.sessions)].find(
        (session) => session.sessionId === destination?.sessionId,
      )?.title || "Choose destination"
    );
  }

  select(destination: CaptureDestination) {
    this.selectedDestination = destination;
    this.props.onSelect?.(destination);
  }

  /** The project owning the highlighted destination (a session or its Project Chat); global chats have none. */
  get selectedProjectPath() {
    const destination = this.destination;
    if (!destination) return undefined;
    return this.routing.projects.find((project) =>
      destination.kind === "cake-chat"
        ? project.chatSessionId === destination.sessionId
        : project.sessions.some((session) => session.sessionId === destination.sessionId),
    )?.path;
  }

  /** Projects start collapsed, except the one containing the current selection. */
  isProjectCollapsed(path: string) {
    return !(this.projectExpansion.get(path) ?? path === this.selectedProjectPath);
  }

  toggleProject(path: string) {
    this.projectExpansion.set(path, this.isProjectCollapsed(path));
  }

  isFamilyCollapsed(sessionId: string) {
    return this.collapsedFamilies.has(sessionId);
  }

  toggleFamily(sessionId: string) {
    if (this.collapsedFamilies.has(sessionId)) this.collapsedFamilies.delete(sessionId);
    else this.collapsedFamilies.add(sessionId);
  }

  visibleSessions(sessions: readonly CaptureSessionOption[]) {
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    return sessions.filter((session) => {
      let parent = session.familyParentSessionId;
      const visited = new Set([session.sessionId]);
      while (parent && !visited.has(parent)) {
        if (this.isFamilyCollapsed(parent)) return false;
        visited.add(parent);
        parent = byId.get(parent)?.familyParentSessionId;
      }
      return true;
    });
  }
}
