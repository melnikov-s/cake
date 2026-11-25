import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DateTime, Effect, Schema } from "effect";
import {
  AutomationOccurrenceId,
  type AutomationError,
  type AutomationId,
  type AutomationOccurrence,
} from "../../contracts/automations/automation-data";
import {
  GITHUB_WEBHOOK_MAX_BODY,
  GitHubDeliveryId,
  GitHubRepository,
  type GitHubWebhookFilter,
  type GitHubWebhookNote,
  type GitHubWebhookPreview,
  type GitHubWebhookStatus,
} from "../../contracts/automations/github-webhooks";
import { AutomationConfiguration } from "../../services/automations/AutomationConfiguration";
import { AutomationRecords } from "../../services/automations/AutomationRecords";
import { automationError } from "./automationDefinitions";
import { decideAdmission } from "./automationPolicy";

export const githubWebhookPath = (id: AutomationId) => `/webhooks/github/${id}`;
export const maxConcurrentWebhookRuns = 4;
const maxPendingWebhooks = 32;
const maxPendingPerTrigger = 8;

const reviewPayload = Schema.Struct({
  action: Schema.String,
  repository: Schema.Struct({ full_name: GitHubRepository }),
  pull_request: Schema.Struct({
    number: Schema.Int.check(Schema.isGreaterThan(0)),
    title: Schema.String,
  }),
  review: Schema.Struct({
    user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
    state: Schema.String,
    body: Schema.NullOr(Schema.String),
  }),
});

const evaluate = (
  filter: GitHubWebhookFilter,
  event: string,
  raw: Uint8Array,
): GitHubWebhookPreview => {
  if (raw.length > GITHUB_WEBHOOK_MAX_BODY)
    return { _tag: "invalid", reason: "Payload exceeds 1 MiB." };
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return { _tag: "invalid", reason: "Expected a UTF-8 JSON payload." };
  }
  if (event !== filter.event)
    return { _tag: "ignored", reason: "Event does not match the saved filter." };
  const decoded = Schema.decodeUnknownResult(reviewPayload)(input);
  if (decoded._tag === "Failure")
    return { _tag: "invalid", reason: "Expected a GitHub pull request review payload." };
  const { action, repository, pull_request: pr, review } = decoded.success;
  if (
    repository.full_name.toLowerCase() !== filter.repository.toLowerCase() ||
    action !== filter.action
  )
    return {
      _tag: "ignored",
      reason: "Repository or review action does not match the saved filter.",
    };
  const selected = new Set(filter.fields);
  return {
    _tag: "match",
    fields: {
      event: filter.event,
      repository: repository.full_name,
      action,
      pullRequest: pr.number,
      ...(selected.has("title") ? { title: pr.title.slice(0, 256) } : null),
      ...(selected.has("reviewer") && review.user
        ? { reviewer: review.user.login.slice(0, 128) }
        : null),
      ...(selected.has("state") ? { state: review.state.slice(0, 32) } : null),
      ...(selected.has("body") && review.body !== null
        ? { body: review.body.slice(0, 2048) }
        : null),
    },
  };
};

export const webhookStatus = Effect.fn("GitHubWebhooks.status")(function* (
  id: AutomationId,
): Effect.fn.Return<GitHubWebhookStatus, never, AutomationRecords | AutomationConfiguration> {
  const { webhookPort } = yield* AutomationConfiguration;
  const trigger = (yield* AutomationRecords)
    .snapshot()
    .webhookTriggers?.find((item) => item.automationId === id);
  return {
    ...(webhookPort === undefined
      ? null
      : { endpoint: `http://127.0.0.1:${webhookPort}${githubWebhookPath(id)}` }),
    hasSecret: trigger !== undefined,
    ...(trigger?.lastNote ? { lastNote: trigger.lastNote } : null),
  };
});

export const rotateWebhookSecret = Effect.fn("GitHubWebhooks.rotateSecret")(function* (
  id: AutomationId,
) {
  const records = yield* AutomationRecords;
  const secret = randomBytes(32).toString("hex");
  yield* records.transact((ledger) =>
    Effect.gen(function* () {
      const automation = ledger.automations.find((item) => item.id === id);
      if (automation?.definition.trigger._tag !== "Webhook")
        return yield* automationError(
          "rotateSecret",
          "Save a GitHub webhook automation first.",
          "invalid-state",
        );
      const existing = ledger.webhookTriggers?.find((item) => item.automationId === id);
      return {
        ledger: {
          ...ledger,
          webhookTriggers: [
            ...(ledger.webhookTriggers ?? []).filter((item) => item.automationId !== id),
            { ...existing, automationId: id, secret },
          ],
        },
        result: undefined,
      };
    }),
  );
  return { secret };
});

/** Evaluates a pasted test delivery against the saved filter without accepting or recording it. */
export const previewWebhook = Effect.fn("GitHubWebhooks.preview")(function* (
  id: AutomationId,
  event: string,
  body: string,
) {
  const automation = (yield* AutomationRecords)
    .snapshot()
    .automations.find((item) => item.id === id);
  if (automation?.definition.trigger._tag !== "Webhook")
    return yield* automationError(
      "preview",
      "Save a GitHub webhook automation first.",
      "invalid-state",
    );
  return evaluate(automation.definition.trigger.filter, event, Buffer.from(body, "utf8"));
});

interface Delivery {
  readonly id: string;
  readonly event: string;
  readonly signature: string;
  readonly raw: Buffer;
}

type Outcome = "unauthorized" | "invalid" | "ignored" | "duplicate" | "full" | "queued";

/** HMAC verification precedes JSON parsing and writes. The transaction rechecks the key and
 * evaluates the current saved definition, then commits deduplication and the occurrence together. */
export const acceptWebhook = Effect.fn("GitHubWebhooks.accept")(function* (
  id: AutomationId,
  delivery: Delivery,
): Effect.fn.Return<Outcome, AutomationError, AutomationRecords> {
  const records = yield* AutomationRecords;
  const secret = records
    .snapshot()
    .webhookTriggers?.find((item) => item.automationId === id)?.secret;
  if (
    !secret ||
    !/^sha256=[0-9a-f]{64}$/.test(delivery.signature) ||
    !timingSafeEqual(
      createHmac("sha256", secret).update(delivery.raw).digest(),
      Buffer.from(delivery.signature.slice(7), "hex"),
    )
  )
    return "unauthorized";
  if (!Schema.is(GitHubDeliveryId)(delivery.id)) return "invalid";
  const digest = createHash("sha256").update(delivery.raw).digest("hex");
  const now = DateTime.formatIso(yield* DateTime.now);
  return yield* records.transact<Outcome, never>((ledger) =>
    Effect.sync(() => {
      const trigger = ledger.webhookTriggers?.find((item) => item.automationId === id);
      const automation = ledger.automations.find((item) => item.id === id);
      const unchanged = (result: Outcome) => ({ ledger, result });
      if (
        !trigger ||
        trigger.secret !== secret ||
        automation?.definition.trigger._tag !== "Webhook"
      )
        return unchanged("unauthorized");
      const note = (outcome: GitHubWebhookNote["outcome"], reason: string) => ({
        ledger: {
          ...ledger,
          webhookTriggers: (ledger.webhookTriggers ?? []).map((item) =>
            item.automationId === id
              ? { ...item, lastNote: { outcome, reason, at: now, deliveryId: delivery.id } }
              : item,
          ),
        },
        result: outcome,
      });
      if (
        ledger.occurrences.some(
          (item) =>
            item.automationId === id &&
            item.source._tag === "Webhook" &&
            (item.source.deliveryId === delivery.id || item.source.bodyDigest === digest),
        )
      )
        return note("duplicate", "This delivery was already recorded.");
      if (automation.state._tag !== "active") return note("ignored", "This webhook is not active.");
      const preview = evaluate(automation.definition.trigger.filter, delivery.event, delivery.raw);
      if (preview._tag === "invalid") return unchanged("invalid");
      if (preview._tag === "ignored") return note("ignored", preview.reason);
      const queued = ledger.occurrences.filter(
        (item) => item.source._tag === "Webhook" && item.disposition._tag === "queued",
      );
      const pendingForTrigger = queued.filter((item) => item.automationId === id).length;
      const overlap = decideAdmission({
        state: automation.state,
        overlap: automation.definition.overlap,
        source: "event",
        runningSessions:
          pendingForTrigger +
          ledger.runs.filter((run) => run.automationId === id && run.status._tag === "running")
            .length,
      });
      if (
        overlap.action !== "skip" &&
        (queued.length >= maxPendingWebhooks || pendingForTrigger >= maxPendingPerTrigger)
      )
        return unchanged("full");
      const occurrence: AutomationOccurrence = {
        id: AutomationOccurrenceId.make(crypto.randomUUID()),
        automationId: id,
        occurredAt: now,
        source: {
          _tag: "Webhook",
          deliveryId: delivery.id,
          bodyDigest: digest,
          data: preview.fields,
        },
        definition: automation.definition,
        disposition:
          overlap.action === "skip"
            ? { _tag: "skipped", reason: overlap.reason }
            : { _tag: "queued" },
      };
      return {
        ledger: { ...ledger, occurrences: [...ledger.occurrences, occurrence] },
        result: overlap.action === "skip" ? "ignored" : "queued",
      };
    }),
  );
});
