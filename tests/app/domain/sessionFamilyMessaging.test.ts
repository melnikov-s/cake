import { describe, it } from "vitest";

// Review stubs. Implement against the real route Effect and fake external Services,
// not by constructing runtime options to obtain a callback. Retain adapter coverage.
describe("Session Family messaging operation", () => {
  it.todo("routes a reply to the consumed request rather than later queued work");
  it.todo("records a substantive completion report without sending it before settlement");
  it.todo("starts idle recipients, queues active recipients, and steers only when requested");
  it.todo("rejects delivery to a resolved family and preserves correlation and receipt tracking");
  it.todo("retains coordinator routing and the not-handled fallback for unrelated destinations");
});
