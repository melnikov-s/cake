import { Store, observable } from "r-state-tree";
import type { ApplicationState } from "../../contracts/application/application-data";
import type { CakeArtifactV1 } from "../../contracts/artifacts/artifact-contract";
import type { ArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";
import {
  widgetAppliesTo,
  type WidgetAttachment,
  type WidgetSlot,
  type WidgetTarget,
} from "../../contracts/widgets/widget-attachment";
import { ClientContext } from "./context/ClientContext";
import { ArtifactNavigationContext } from "./context/ArtifactNavigationContext";

/** Placements are application-owned. Widget source and saved state remain artifact-owned. */
export class WidgetAttachmentStore extends Store {
  private revision = -1;
  readonly attachments: WidgetAttachment[] = observable([]);
  readonly artifacts = observable(
    new Map<ArtifactLineageId, Extract<CakeArtifactV1, { kind: "widget" }>>(),
  );
  readonly errors = observable(new Map<string, string>());
  private readonly loading = new Map<string, Promise<void>>();
  readonly placementRequests = observable(
    new Map<ArtifactLineageId, { pending: boolean; error?: string; slot?: WidgetSlot }>(),
  );

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

  get tabWidgets() {
    return this.attachments
      .filter((entry) => entry.slot === "tab")
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  /** Out-of-scope tabs are neither discoverable nor mounted; selection never changes applicability. */
  get availableTabWidgets() {
    const session = ArtifactNavigationContext.consume(this)?.()?.session;
    const seen = new Set<ArtifactLineageId>();
    return this.tabWidgets.filter((entry) => {
      if (
        entry.target.kind !== "global" &&
        (!session || !widgetAppliesTo(entry.target, session.sessionId, session.kind))
      )
        return false;
      if (seen.has(entry.lineageId)) return false;
      seen.add(entry.lineageId);
      return true;
    });
  }

  title(attachment: WidgetAttachment) {
    return this.artifacts.get(attachment.lineageId)?.title ?? attachment.id;
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

  /** Place the displayed instance, never instantiate or replace its saved state. */
  async attachViewedWidget(lineageId: ArtifactLineageId, slot: WidgetSlot, sessionId?: string) {
    if (this.placementRequests.get(lineageId)?.pending) return;
    this.placementRequests.set(lineageId, { pending: true });
    try {
      if (!sessionId && slot !== "tab")
        throw new Error("Open a conversation to attach this widget to a chat slot");
      const target: WidgetTarget = sessionId ? { kind: "session", sessionId } : { kind: "global" };
      const placements = this.attachments.filter((entry) => entry.lineageId === lineageId);
      const destination = ArtifactNavigationContext.consume(this)?.()?.session;
      const applicable = placements.filter(({ target }) => {
        if (target.kind === "global") return true;
        if (target.kind === "session") return target.sessionId === sessionId;
        return (
          destination &&
          destination.sessionId === sessionId &&
          widgetAppliesTo(target, destination.sessionId, destination.kind)
        );
      });
      if (placements.length > 0 && applicable.length === 0)
        throw new Error(
          "Widget scope conflict: no existing placement applies to this conversation. Nothing was changed.",
        );
      // Prefer a compatible Workspace placement, then an exact conversation placement.
      // Never move, unhide, retarget or duplicate a placement belonging to another scope.
      const existing =
        applicable.find((entry) => entry.slot === "tab") ??
        applicable.find((entry) => entry.target.kind === "session") ??
        applicable[0];
      if (existing) {
        await this.move(existing, slot);
        if (!this.signal.aborted && existing.hidden) await this.hide(existing.id, false);
      } else {
        await this.client.application.attachWidget(
          { id: crypto.randomUUID(), lineageId, slot, target },
          { signal: this.signal },
        );
      }
      if (!this.signal.aborted) this.placementRequests.set(lineageId, { pending: false, slot });
    } catch (error) {
      if (!this.signal.aborted)
        this.placementRequests.set(lineageId, {
          pending: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
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
