import type { InterviewRecord } from "./interview";
import type { JsonValue } from "../serialization/json-contract";

export interface CakeInterviewOperationOptions {
  requestInterview(record: InterviewRecord, signal: AbortSignal): Promise<JsonValue | undefined>;
}
