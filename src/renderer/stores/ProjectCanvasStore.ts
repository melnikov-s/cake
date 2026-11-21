import { Store } from "r-state-tree";
import type { CanvasTarget } from "../../contracts/project-canvas/canvas-link";
import { canvasLink } from "../../contracts/project-canvas/canvas-link";
import type { CanvasPinInput } from "../../contracts/project-canvas/project-canvas";
import type { Client } from "../client/Client";
import { ProjectCanvas } from "../models/ProjectCanvas";

export class ProjectCanvasStore extends Store<{ client: Client["projectCanvas"] }> {
  readonly model = ProjectCanvas.create();
  projectChatId?: string;
  target?: CanvasTarget;
  loaded = false;
  error?: string;
  saving = false;
  pinError?: string;

  constructor(props: ProjectCanvasStore["props"]) {
    super(props);
    this.effect(() => () => this.model[Symbol.dispose]());
  }

  reveal(target: CanvasTarget) {
    this.target = { ...target };
  }

  closeReview() {
    this.target = undefined;
    this.pinError = undefined;
  }

  connect(projectChatId: string) {
    this.projectChatId = projectChatId;
    this.loaded = false;
    this.error = undefined;
    this.model.replace({ version: 1, cards: [] });
    if (this.target?.projectChatId !== projectChatId) this.closeReview();
    const disconnect = this.props.client.observe(
      projectChatId,
      (snapshot) => {
        this.model.replace(snapshot);
        this.loaded = true;
        this.error = undefined;
      },
      (error) => {
        this.error = error instanceof Error ? error.message : String(error);
      },
    );
    return () => {
      disconnect();
      this.projectChatId = undefined;
      this.loaded = false;
      this.model.replace({ version: 1, cards: [] });
    };
  }

  preview(target: CanvasTarget, signal: AbortSignal) {
    return this.props.client.preview(
      { projectChatId: target.projectChatId, link: canvasLink(target) },
      { signal },
    );
  }

  async addPin(target: CanvasTarget, draft: Omit<CanvasPinInput, "link">) {
    if (this.saving || target.projectChatId !== this.projectChatId) return false;
    this.saving = true;
    this.pinError = undefined;
    try {
      await this.props.client.pin(
        { projectChatId: target.projectChatId, link: canvasLink(target), ...draft },
        { signal: this.signal },
      );
      return !this.signal.aborted;
    } catch (error) {
      if (this.projectChatId === target.projectChatId && !this.signal.aborted)
        this.pinError = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      if (!this.signal.aborted) this.saving = false;
    }
  }
}
