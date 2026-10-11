import { describe, it } from "vitest";

// Review stubs. Reuse real family storage and mutate membership without rebuilding
// runtime options. Snapshot/query results never replace authoritative command checks.
describe("Project Session live agent policy", () => {
  it.todo(
    "changes standalone fork and deferral policy after the same session becomes a family root",
  );
  it.todo("reports newly created direct children without reacquiring the parent runtime");
  it.todo("rejects an agent fork after family promotion while preserving ordinary user forks");
});
