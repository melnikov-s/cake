import { Store, observable } from "r-state-tree";
import type {
  CaptureDestination,
  CapturePreferences,
  CaptureSessionOption,
} from "../../contracts/desktop/screen-capture-data";

/** One native capture's destination and disclosures. No catalog observations or sidebar UI state. */
export class CaptureDestinationPickerStore extends Store<{
  routing: CapturePreferences;
  currentDestination?(): CaptureDestination | undefined;
  onSelect?(destination: CaptureDestination): void;
}> {
  private selectedDestination: CaptureDestination | undefined =
    this.props.routing.defaultDestination;

  get destination() {
    return this.props.currentDestination
      ? this.props.currentDestination()
      : this.selectedDestination;
  }
  private readonly collapsedProjects = observable(new Set<string>());
  private readonly collapsedFamilies = observable(new Set<string>());

  get routing() {
    return this.props.routing;
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

  isProjectCollapsed(path: string) {
    return this.collapsedProjects.has(path);
  }

  toggleProject(path: string) {
    if (this.collapsedProjects.has(path)) this.collapsedProjects.delete(path);
    else this.collapsedProjects.add(path);
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
