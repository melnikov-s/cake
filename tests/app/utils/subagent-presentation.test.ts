import { expect, it } from "vitest";
import { subagentTaskTitle } from "../../../src/contracts/subagents/subagent-presentation";

it.each([
  ["Bug-fix workflow audit", "Bug-fix workflow audit"],
  ["\n  Bug-fix  workflow\taudit\r\nRead-only instructions", "Bug-fix workflow audit"],
  ["Audit ".repeat(30), `${"Audit ".repeat(13)}A…`],
  [undefined, "Delegated task"],
  ["", "Delegated task"],
  [" \n\t ", "Delegated task"],
])("names a worker from its assignment: %j", (task, expected) => {
  expect(subagentTaskTitle(task)).toBe(expected);
});
