import { expect, it } from "vitest";
import { unexpectedNodeStderr } from "./fixtures/node-stderr";

const sqliteWarning =
  "(node:123) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n" +
  "(Use `node --trace-warnings ...` to show where the warning was created)\n";

it("permits only the known Node SQLite import warning", () => {
  expect(unexpectedNodeStderr(sqliteWarning)).toBe("");
  expect(unexpectedNodeStderr(sqliteWarning.replaceAll("\n", "\r\n"))).toBe("");
  expect(unexpectedNodeStderr(sqliteWarning + "Unexpected backend error\n")).toBe(
    "Unexpected backend error\n",
  );
  const unknown = "(node:123) ExperimentalWarning: Another experimental feature\n";
  expect(unexpectedNodeStderr(unknown)).toBe(unknown);
});
