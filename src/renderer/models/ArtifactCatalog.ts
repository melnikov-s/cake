import { Model, applySnapshot, batch, child, observable } from "r-state-tree";
import type {
  ArtifactLineageDetail,
  ArtifactLineageSummary,
  ArtifactLink as ArtifactLinkValue,
  ArtifactRevision as ArtifactRevisionValue,
  ArtifactRevisionMetadata,
  EffectiveArtifactProjection,
} from "../../domain/artifacts/artifact-lineage";
import { ArtifactAssociation } from "./ArtifactAssociation";
import { ArtifactLineage } from "./ArtifactLineage";
import { ArtifactLink } from "./ArtifactLink";
import { ArtifactRevision } from "./ArtifactRevision";

const revisionId = (lineageId: string, revision: number) => `${lineageId}@r${revision}`;
const linkId = (link: ArtifactLinkValue) =>
  `${link.lineageId}:${link.target.type}:${link.target.type === "session" ? link.target.sessionId : link.target.familyId}`;

const revisionSnapshot = (lineageId: string, value: ArtifactRevisionValue) => ({
  id: revisionId(lineageId, value.metadata.revision),
  lineageId,
  revision: value.metadata.revision,
  digest: value.metadata.digest,
  kind: value.metadata.kind,
  publishedAt: value.metadata.publishedAt,
  publishedBySessionId: value.metadata.publishedBySessionId,
  workingDirectory: value.metadata.workingDirectory,
  restoredFromRevision: value.metadata.restoredFromRevision,
  snapshot: value.snapshot,
});

const linkSnapshot = (value: ArtifactLinkValue) => ({
  id: linkId(value),
  lineageId: value.lineageId,
  target: value.target,
  mode: value.selection.mode,
  pinnedRevision: value.selection.mode === "pinned" ? value.selection.revision : undefined,
  createdAt: value.createdAt,
});

export class ArtifactCatalog extends Model {
  @child(ArtifactLineage) lineages: ArtifactLineage[] = observable([]);
  @child(ArtifactLink) links: ArtifactLink[] = observable([]);
  @child(ArtifactAssociation) associations: ArtifactAssociation[] = observable([]);

  find(lineageId: string) {
    return this.lineages.find((lineage) => lineage.id === lineageId);
  }

  associationsFor(sessionId: string) {
    return this.associations.filter((association) => association.sessionId === sessionId);
  }

  upsertSummary(summary: ArtifactLineageSummary) {
    batch(() => {
      let lineage = this.find(summary.id);
      if (!lineage) {
        lineage = ArtifactLineage.create({
          id: summary.id,
          createdAt: summary.createdAt,
          latestRevision: summary.latestRevision,
          title: summary.title,
          stableRef: summary.stableRef,
        });
        this.lineages.push(lineage);
      } else {
        lineage.createdAt = summary.createdAt;
        lineage.latestRevision = summary.latestRevision;
        lineage.title = summary.title;
        lineage.stableRef = summary.stableRef;
      }
      const existing = lineage.revision(summary.latest.revision);
      const metadata = {
        id: revisionId(summary.id, summary.latest.revision),
        lineageId: summary.id,
        revision: summary.latest.revision,
        digest: summary.latest.digest,
        kind: summary.latest.kind,
        publishedAt: summary.latest.publishedAt,
        publishedBySessionId: summary.latest.publishedBySessionId,
        workingDirectory: summary.latest.workingDirectory,
        restoredFromRevision: summary.latest.restoredFromRevision,
      };
      if (existing) Object.assign(existing, metadata);
      else lineage.revisions.push(ArtifactRevision.create(metadata));
    });
  }

  applyDetail(detail: ArtifactLineageDetail) {
    batch(() => {
      this.upsertSummary(detail.lineage);
      const lineage = this.find(detail.lineage.id)!;
      const ids = new Set(detail.links.map(linkId));
      for (let index = this.links.length - 1; index >= 0; index -= 1)
        if (this.links[index]!.lineageId === lineage.id && !ids.has(this.links[index]!.id))
          this.links.splice(index, 1);
      for (const value of detail.links) {
        const existing = this.links.find((link) => link.id === linkId(value));
        if (existing) applySnapshot(existing, linkSnapshot(value));
        else this.links.push(ArtifactLink.create(linkSnapshot(value)));
      }
    });
  }

  applyHistory(lineageId: string, revisions: ReadonlyArray<ArtifactRevisionMetadata>) {
    batch(() => {
      const lineage = this.find(lineageId);
      if (!lineage) return;
      for (const metadata of revisions) {
        const existing = lineage.revision(metadata.revision);
        const value = {
          id: revisionId(lineage.id, metadata.revision),
          lineageId: lineage.id,
          revision: metadata.revision,
          digest: metadata.digest,
          kind: metadata.kind,
          publishedAt: metadata.publishedAt,
          publishedBySessionId: metadata.publishedBySessionId,
          workingDirectory: metadata.workingDirectory,
          restoredFromRevision: metadata.restoredFromRevision,
        };
        if (existing) Object.assign(existing, value);
        else lineage.revisions.push(ArtifactRevision.create(value));
      }
    });
  }

  upsertRevision(
    value: ArtifactRevisionValue,
    authoritativeLatestRevision: number = value.metadata.revision,
  ) {
    batch(() => {
      let lineage = this.find(value.lineageId);
      if (!lineage) {
        lineage = ArtifactLineage.create({
          id: value.lineageId,
          createdAt: value.metadata.publishedAt,
          latestRevision: authoritativeLatestRevision,
          title:
            value.metadata.revision >= authoritativeLatestRevision
              ? value.snapshot.title
              : undefined,
          stableRef: `cake://artifact/${value.lineageId}`,
        });
        this.lineages.push(lineage);
      }
      const previousLatestRevision = lineage.latestRevision;
      lineage.latestRevision = Math.max(
        previousLatestRevision,
        authoritativeLatestRevision,
        value.metadata.revision,
      );
      if (value.metadata.revision >= lineage.latestRevision && value.snapshot.title !== undefined)
        lineage.title = value.snapshot.title;
      const existing = lineage.revision(value.metadata.revision);
      if (existing) applySnapshot(existing, revisionSnapshot(value.lineageId, value));
      else
        lineage.revisions.push(ArtifactRevision.create(revisionSnapshot(value.lineageId, value)));
    });
    return this.find(value.lineageId)!;
  }

  applyEffective(sessionId: string, values: ReadonlyArray<EffectiveArtifactProjection>) {
    batch(() => {
      const active = new Set(values.map((value) => `${sessionId}:${value.revision.lineageId}`));
      for (let index = this.associations.length - 1; index >= 0; index -= 1) {
        const association = this.associations[index]!;
        if (association.sessionId === sessionId && !active.has(association.id))
          this.associations.splice(index, 1);
      }
      for (const value of values) {
        const lineage = this.upsertRevision(value.revision, value.latestRevision);
        const canonicalLinkId = linkId(value.link);
        let link = this.links.find((candidate) => candidate.id === canonicalLinkId);
        if (link) applySnapshot(link, linkSnapshot(value.link));
        else {
          link = ArtifactLink.create(linkSnapshot(value.link));
          this.links.push(link);
        }
        const id = `${sessionId}:${value.revision.lineageId}`;
        const snapshot = {
          id,
          sessionId,
          lineage: { id: lineage.id },
          link: { id: link.id },
          selectedRevision: value.revision.metadata.revision,
          latestRevision: value.latestRevision,
          stableRef: value.stableRef,
          exactRef: value.exactRef,
        };
        const existing = this.associations.find((association) => association.id === id);
        if (existing) applySnapshot(existing, snapshot);
        else this.associations.push(ArtifactAssociation.create(snapshot));
      }
    });
  }
}
