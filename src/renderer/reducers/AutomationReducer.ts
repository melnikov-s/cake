import { applySnapshot, batch, type Snapshot } from "r-state-tree";
import type { AutomationCatalogUpdate } from "../../contracts/automations/automation-control";
import type {
  AutomationSummary as SummaryData,
  AutomationSessionSummary as SessionData,
} from "../../contracts/automations/automation-data";
import type { AutomationCatalog } from "../models/AutomationCatalog";
import { AutomationSummary } from "../models/AutomationSummary";
import { AutomationSessionSummary } from "../models/AutomationSessionSummary";

// SAFETY: RPC validates this record; Snapshot's mapped type incorrectly expands
// branded strings into object methods. The intersection preserves that authority type.
const summarySnapshot = (summary: SummaryData) =>
  summary as SummaryData & Snapshot<AutomationSummary>;
const sessionSnapshot = (summary: SessionData) => {
  // SAFETY: the validated identity contains only JSON fields; the extra key is the
  // same canonical session ID, and the intersection preserves its branded evidence.
  return { ...summary, sessionId: summary.identity.sessionId } as SessionData & {
    sessionId: string;
  } & Snapshot<AutomationSessionSummary>;
};

/** Ordered authority updates only; commands never optimistically invent catalog facts. */
export function applyAutomationCatalogUpdate(
  model: AutomationCatalog,
  update: AutomationCatalogUpdate,
) {
  batch(() => {
    if (update._tag === "Snapshot") {
      applySnapshot(model, {
        revision: update.snapshot.revision,
        automations: update.snapshot.automations.map(summarySnapshot),
        unresolvedSessions: update.snapshot.unresolvedSessions.map(sessionSnapshot),
      });
      model.loaded = true;
      model.observationError = undefined;
      return;
    }
    if (update.revision <= model.revision) return;
    const event = update.event;
    switch (event._tag) {
      case "Upserted": {
        const existing = model.automations.find((item) => item.id === event.summary.id);
        if (existing) applySnapshot(existing, summarySnapshot(event.summary));
        else model.automations.push(AutomationSummary.create(summarySnapshot(event.summary)));
        break;
      }
      case "SessionUpserted": {
        const index = model.unresolvedSessions.findIndex(
          (item) => item.sessionId === event.summary.identity.sessionId,
        );
        if (event.summary.resolved) {
          if (index >= 0) model.unresolvedSessions.splice(index, 1);
        } else if (index >= 0) {
          applySnapshot(model.unresolvedSessions[index]!, sessionSnapshot(event.summary));
        } else
          model.unresolvedSessions.push(
            AutomationSessionSummary.create(sessionSnapshot(event.summary)),
          );
        break;
      }
      case "SessionRemoved": {
        const index = model.unresolvedSessions.findIndex(
          (item) => item.sessionId === event.sessionId,
        );
        if (index >= 0) model.unresolvedSessions.splice(index, 1);
        break;
      }
    }
    model.revision = update.revision;
  });
}
