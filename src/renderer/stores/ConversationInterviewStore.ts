import { Store, child, createStore, observable } from "r-state-tree";
import type { InterviewRecord, InterviewResult } from "../../contracts/interviews/interview";
import type { UiPart } from "../../contracts/conversations/session-contract";
import type { StoreEvent } from "../events/StoreEvent";
import { InterviewStore } from "./InterviewStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

/** One conversation owns live correlations and unsent answers; Pi owns completed results. */
export class ConversationInterviewStore extends Store<{
  sessionId: string;
  parts(): readonly UiPart[];
  isStreaming(): boolean;
  operations: SessionOperationCoordinatorStore;
}> {
  private readonly requests = observable(
    new Map<string, Extract<StoreEvent, { type: "interview-requested" }>>(),
  );

  constructor(props: ConversationInterviewStore["props"]) {
    super(props);
    this.reaction(
      () =>
        this.props
          .parts()
          .flatMap((part) =>
            part.kind === "tool" && part.interview && part.state !== "running"
              ? [part.interview.id]
              : [],
          ),
      (settled) => {
        for (const id of settled) this.requests.delete(id);
      },
    );
  }

  receive(event: Extract<StoreEvent, { type: "interview-requested" }>) {
    if (event.record.sessionId === this.props.sessionId) this.requests.set(event.record.id, event);
  }

  clearPending() {
    this.requests.clear();
  }

  get waiting() {
    return this.requests.size > 0;
  }

  @child
  get interviews(): InterviewStore[] {
    const records = new Map<string, { record: InterviewRecord; result?: InterviewResult }>();
    for (const part of this.props.parts())
      if (part.kind === "tool" && part.interview?.sessionId === this.props.sessionId)
        records.set(part.interview.id, { record: part.interview, result: part.interviewResult });
    // Requests can arrive before their Pi tool metadata reaches the projection.
    for (const [id, request] of this.requests)
      if (!records.has(id)) records.set(id, { record: request.record });
    return [...records.values()].map(({ record, result }) =>
      createStore(InterviewStore, {
        key: record.id,
        record,
        result,
        request: this.requests.get(record.id),
        operations: this.props.operations,
        isStreaming: this.props.isStreaming,
        onResponded: () => {
          this.requests.delete(record.id);
        },
      }),
    );
  }

  find(id: string) {
    return this.interviews.find((interview) => interview.record.id === id);
  }

  get error() {
    return this.interviews.find((interview) => interview.error);
  }
}
