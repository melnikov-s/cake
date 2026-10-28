import { Store, observable } from "r-state-tree";
import type { ArtifactPresentationContext } from "../../contracts/artifacts/artifact-presentation-context";

/** Ephemeral window presentation; never persisted into artifact state or another conversation. */
export class ArtifactPresentationStore extends Store<{
  activeSessionId(): string | undefined;
}> {
  private readonly surfaces = observable<
    {
      surfaceId: string;
      originSessionId: string | undefined;
      context: ArtifactPresentationContext;
    }[]
  >([]);
  chatVisible = false;
  chatWidth = 400;

  show(surfaceId: string, context: ArtifactPresentationContext) {
    const existing = this.surfaces.find((surface) => surface.surfaceId === surfaceId);
    if (existing) existing.context = context;
    else this.surfaces.push({ surfaceId, context, originSessionId: this.props.activeSessionId() });
  }

  close(surfaceId: string) {
    const index = this.surfaces.findIndex((surface) => surface.surfaceId === surfaceId);
    if (index < 0) return;
    this.surfaces.splice(index, 1);
    if (!this.surfaces.length) this.chatVisible = false;
  }

  capture(sessionId: string): ArtifactPresentationContext | null {
    // Outside sends are clear candidates. The backend's sent history determines
    // whether this conversation actually has a target to clear, including after reload.
    const active = this.surfaces.at(-1);
    if (
      !active ||
      this.props.activeSessionId() !== active.originSessionId ||
      active.context.sessionId !== sessionId
    )
      return null;
    return { ...active.context };
  }

  toggleChat() {
    this.chatVisible = !this.chatVisible;
  }

  setChatWidth(width: number) {
    this.chatWidth = width;
  }
}
