import { observable, Store } from "r-state-tree";
import {
  validateInterviewResponse,
  type InterviewField,
  type InterviewRecord,
  type InterviewResult,
} from "../../contracts/interviews/interview";
import type { JsonValue } from "../../contracts/serialization/json-contract";
import type { StoreEvent } from "../events/StoreEvent";
import { describeError } from "../lib/error-details";
import { listedOptions, type InterviewFormValue } from "../lib/interview-form";
import { ClientContext } from "./context/ClientContext";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export interface InterviewStoreProps {
  record: InterviewRecord;
  result?: InterviewResult;
  request?: Extract<StoreEvent, { type: "interview-requested" }>;
  operations: SessionOperationCoordinatorStore;
  isStreaming(): boolean;
  onResponded(): void;
}

/** One session-owned interview invocation. User input outlives React rows.
 * The session's keyed child collection owns disposal. Completed answers are
 * Pi tool results; unsent answers are window-local Store state. Input changes
 * are synchronous, while only one response/delivery may be in flight. */
export class InterviewStore extends Store<InterviewStoreProps> {
  readonly values: Record<string, InterviewFormValue> = observable({});
  readonly customRows = observable(new Set<string>());
  step = 0;
  responding = false;
  error: string | undefined;
  errorDetails: string | undefined;
  private localResult: InterviewResult | undefined;

  constructor(props: InterviewStore["props"]) {
    super(props);
    if (!props.result && props.record.request.view.type === "form")
      for (const field of props.record.request.view.fields) {
        const recommended = field.type === "select" ? listedOptions(field)?.[0] : undefined;
        if (recommended) this.values[field.id] = recommended.value;
      }
    this.reaction(
      () => this.result,
      (result) => {
        if (!result) return;
        for (const fieldId of Object.keys(this.values)) delete this.values[fieldId];
        this.customRows.clear();
        this.step = 0;
      },
    );
  }

  get record() {
    return this.props.record;
  }
  get result() {
    return this.props.result ?? this.localResult;
  }
  get requested() {
    return Boolean(this.props.request);
  }
  get submitted() {
    return this.result !== undefined && !this.result.cancelled;
  }
  get cancelled() {
    return this.result?.cancelled === true;
  }
  get client() {
    return ClientContext.consume(this)!;
  }

  setValue(fieldId: string, value: InterviewFormValue) {
    this.values[fieldId] = value;
  }
  selectOption(field: InterviewField, value: string) {
    this.customRows.delete(field.id);
    this.values[field.id] = value;
  }
  selectCustomRow(field: InterviewField) {
    this.customRows.add(field.id);
    if (listedOptions(field)?.some((option) => option.value === this.values[field.id]))
      this.values[field.id] = "";
  }
  goTo(next: number) {
    const count =
      this.record.request.view.type === "form" ? this.record.request.view.fields.length : 0;
    this.step = Math.max(0, Math.min(count, next));
  }

  async respond(value?: JsonValue, cancelled = false) {
    if (this.responding || this.result) return;
    const request = this.props.request;
    this.error = undefined;
    this.errorDetails = undefined;
    let operationId: string | undefined;
    try {
      const answer = cancelled
        ? undefined
        : validateInterviewResponse(this.record.request.responseSchema, value);
      this.responding = true;
      if (request) {
        await this.client.interviews.respond(
          {
            operationId: request.operationId,
            interviewRequestId: request.interviewRequestId,
            sessionId: this.record.sessionId,
            value,
            cancelled,
          },
          { signal: this.signal },
        );
      } else if (!cancelled) {
        operationId = this.props.operations.start(
          `interview-answer:${this.record.sessionId}:${this.record.id}`,
        );
        const command = this.props.isStreaming()
          ? this.client.sessionChats.steer
          : this.client.sessionChats.prompt;
        await command(
          {
            sessionId: this.record.sessionId,
            text: `I answered the earlier interview "${this.record.request.title}": ${JSON.stringify(value ?? null)}`,
            renderUserMessageAsMarkdown: false,
            attachments: [],
          },
          { signal: this.signal },
        );
      }
      if (this.signal.aborted) return;
      this.localResult = cancelled
        ? { interviewId: this.record.id, cancelled: true }
        : { interviewId: this.record.id, cancelled: false, value: answer ?? null };
      this.props.onResponded();
    } catch (error) {
      if (this.signal.aborted) return;
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    } finally {
      if (operationId) this.props.operations.finish(operationId);
      if (!this.signal.aborted) this.responding = false;
    }
  }
}
