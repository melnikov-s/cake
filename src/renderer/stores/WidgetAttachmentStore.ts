import { Store, observable } from "r-state-tree";
import type { ApplicationState } from "../../contracts/application/application-data";
import type { CakeArtifactV1 } from "../../contracts/artifacts/artifact-contract";
import type { ArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";
import {
  widgetAppliesTo,
  type WidgetAttachment,
  type WidgetSlot,
} from "../../contracts/widgets/widget-attachment";
import { ClientContext } from "./context/ClientContext";

/** Placements are application-owned. Widget source and saved state remain artifact-owned. */
export class WidgetAttachmentStore extends Store {
  private revision = -1;
  readonly attachments: WidgetAttachment[] = observable([]);
  readonly artifacts = observable(
    new Map<ArtifactLineageId, Extract<CakeArtifactV1, { kind: "widget" }>>(),
  );
  readonly errors = observable(new Map<string, string>());
  private readonly loading = new Map<string, Promise<void>>();

  get client() {
    return ClientContext.consume(this)!;
  }

  applyApplicationState(revision: number, state: ApplicationState) {
    if (revision < this.revision) return;
    this.revision = revision;
    this.attachments.splice(0, this.attachments.length, ...state.widgetAttachments);
  }

  forSession(sessionId: string, kind: Parameters<typeof widgetAppliesTo>[2], slot: WidgetSlot) {
    return this.attachments
      .filter((entry) => entry.slot === slot && widgetAppliesTo(entry.target, sessionId, kind))
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }

  async load(lineageId: ArtifactLineageId) {
    const pending = this.loading.get(lineageId);
    if (pending) return pending;
    const request = this.loadArtifact(lineageId);
    this.loading.set(lineageId, request);
    try {
      await request;
    } finally {
      this.loading.delete(lineageId);
    }
  }

  private async loadArtifact(lineageId: ArtifactLineageId) {
    try {
      const detail = await this.client.artifacts.detail(lineageId, { signal: this.signal });
      const revision = await this.client.artifacts.readExact(
        lineageId,
        detail.lineage.latestRevision,
        { signal: this.signal },
      );
      if (revision.snapshot.kind !== "widget")
        throw new Error("This attachment no longer references a widget");
      if (this.signal.aborted) return;
      this.artifacts.set(lineageId, revision.snapshot);
      this.errors.delete(lineageId);
    } catch (error) {
      if (!this.signal.aborted)
        this.errors.set(lineageId, error instanceof Error ? error.message : String(error));
    }
  }

  invalidate(lineageId?: string) {
    for (const id of this.artifacts.keys()) if (!lineageId || id === lineageId) void this.load(id);
  }

  async hide(id: string, hidden: boolean) {
    await this.client.application.setWidgetAttachmentHidden(
      { id, hidden },
      { signal: this.signal },
    );
  }

  async move(attachment: WidgetAttachment, slot: WidgetSlot, order = attachment.order) {
    await this.client.application.attachWidget(
      {
        id: attachment.id,
        lineageId: attachment.lineageId,
        target: attachment.target,
        slot,
        order,
      },
      { signal: this.signal },
    );
  }

  async detach(id: string) {
    await this.client.application.detachWidget({ id }, { signal: this.signal });
  }
}
