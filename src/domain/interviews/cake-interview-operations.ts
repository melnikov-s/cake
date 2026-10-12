import type { CakeInterviewOperationOptions } from "../../contracts/interviews/interview-agent-control";
import { Schema } from "effect";
import {
  InterviewDefinition,
  InterviewEntry,
  InterviewResult,
  validateInterviewResponse,
  type InterviewRecord,
} from "../../contracts/interviews/interview";
import { jsonValueSchema, type JsonValue } from "../../contracts/serialization/json-contract";
import type { CakeOperationDefinition } from "../../services/pi/runtime/cake-operation-registry";

export function createCakeInterviewOperations(
  pi: { appendEntry(type: string, data: JsonValue): void },
  options: CakeInterviewOperationOptions,
): CakeOperationDefinition[] {
  return [
    {
      command: "interview.open",
      topic: "interview",
      summary:
        "Open one schema-validated interview form or sandboxed interview widget and wait for submission or cancellation.",
      guidance: [
        "When requirements gathering involves multiple questions or design decisions, use an interview. Present recommended defaults first. Collect independent answers in one structured form.",
        "Ask one question at a time only when later questions depend on earlier answers or the user wants to discuss each decision. Use chat for follow-up questions that depend on submitted answers.",
        "Form fields are optional, so response schemas must accept an empty object. Selects accept listed choices or freeform text. Put the recommended select option first; Cake auto-selects it and always adds the freeform option, so do not list an Other option.",
      ],
      inputSchema: Schema.Struct({ request: InterviewDefinition }),
      examples: [
        {
          input: {
            request: {
              protocol: "cake.request/v1",
              id: "deployment-settings",
              title: "Deployment settings",
              responseSchema: { type: "object", properties: { region: { type: "string" } } },
              view: {
                type: "form",
                fields: [
                  {
                    id: "region",
                    label: "Region",
                    type: "select",
                    options: [{ value: "us-east-1", label: "US East" }],
                  },
                ],
              },
              fallback: { markdown: "Choose a deployment region." },
            },
          },
        },
      ],
      result:
        "The validated response and interview invocation ID, or an explicit cancelled result.",
      limitations: [
        "Interview widgets have no network, filesystem, Node, Electron, parent, or Cake API access.",
      ],
      async execute(input, context) {
        // SAFETY: CakeOperationRegistry decoded input with InterviewDefinition.
        const { request } = input as { request: InterviewDefinition };
        const { sessionId, assistantEntryId } = context.runtime;
        if (!sessionId) throw new Error("The Cake session is not ready");
        if (!assistantEntryId)
          throw new Error("An interview requires an originating assistant message");
        const record: InterviewRecord = {
          id: context.toolCallId,
          sessionId,
          request,
        };
        const entry = Schema.decodeUnknownSync(InterviewEntry)({
          ...record,
          origin: { assistantEntryId, toolCallId: context.toolCallId },
        });
        pi.appendEntry("cake.interview/v1", Schema.decodeUnknownSync(jsonValueSchema)(entry));
        const value = await options.requestInterview(record, context.signal);
        if (value === undefined && context.signal.aborted)
          throw context.signal.reason instanceof Error
            ? context.signal.reason
            : new Error("The interview ended because its turn was interrupted");
        if (value === undefined) return { interviewId: record.id, cancelled: true };
        return Schema.decodeUnknownSync(InterviewResult)({
          interviewId: record.id,
          cancelled: false,
          value: validateInterviewResponse(request.responseSchema, value),
        });
      },
    },
  ];
}
