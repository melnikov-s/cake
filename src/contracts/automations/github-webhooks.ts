import { Schema } from "effect";

export const GITHUB_WEBHOOK_MAX_BODY = 1024 * 1024;
export const GitHubRepository = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
);
const GitHubReviewAction = Schema.Literals(["submitted", "edited", "dismissed"]);
const GitHubReviewField = Schema.Literals(["title", "reviewer", "state", "body"]);
export const GitHubDeliveryId = Schema.String.check(Schema.isUUID());
export const GitHubWebhookFilter = Schema.Struct({
  event: Schema.Literal("pull_request_review"),
  repository: GitHubRepository,
  action: GitHubReviewAction,
  fields: Schema.Array(GitHubReviewField).check(Schema.isUnique(), Schema.isMaxLength(4)),
});
export interface GitHubWebhookFilter extends Schema.Schema.Type<typeof GitHubWebhookFilter> {}

const textField = (max: number) => Schema.String.check(Schema.isMaxLength(max));
export const GitHubReviewData = Schema.Struct({
  event: GitHubWebhookFilter.fields.event,
  repository: GitHubRepository,
  action: GitHubReviewAction,
  pullRequest: Schema.Int.check(Schema.isGreaterThan(0)),
  title: Schema.optionalKey(textField(256)),
  reviewer: Schema.optionalKey(textField(128)),
  state: Schema.optionalKey(textField(32)),
  body: Schema.optionalKey(textField(2_048)),
});
export interface GitHubReviewData extends Schema.Schema.Type<typeof GitHubReviewData> {}

export const GitHubWebhookPreview = Schema.TaggedUnion({
  match: { fields: GitHubReviewData },
  ignored: { reason: Schema.String },
  invalid: { reason: Schema.String },
});
export type GitHubWebhookPreview = typeof GitHubWebhookPreview.Type;

export const GitHubWebhookNote = Schema.Struct({
  outcome: Schema.Literals(["ignored", "duplicate"]),
  deliveryId: GitHubDeliveryId,
  at: Schema.String,
  reason: Schema.String,
});
export interface GitHubWebhookNote extends Schema.Schema.Type<typeof GitHubWebhookNote> {}

export const GitHubWebhookStatus = Schema.Struct({
  endpoint: Schema.optionalKey(Schema.String),
  hasSecret: Schema.Boolean,
  lastNote: Schema.optionalKey(GitHubWebhookNote),
});
export interface GitHubWebhookStatus extends Schema.Schema.Type<typeof GitHubWebhookStatus> {}
