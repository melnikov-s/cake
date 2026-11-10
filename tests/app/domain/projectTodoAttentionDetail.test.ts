import { expect, it } from "vitest";
import {
  projectTodoAttentionDetail,
  projectTodoResultAttentionReason,
} from "../../../src/contracts/projects/project-todos";

const title = "Clean up title-bar icons";

it.each([
  "Open linked result",
  "open linked result.",
  "Open result",
  "Open result:",
  `Open result: ${title}`,
  `Open linked result: ${title}`,
  `Open result: ${title.slice(0, 10)}…`,
  projectTodoResultAttentionReason(title),
])("hides generic result reason %j that only restates the title", (attentionReason) => {
  expect(projectTodoAttentionDetail({ title, attentionReason })).toBeUndefined();
});

it.each([
  "Choose between sidebar and tabs",
  "Open result: Different task",
  `Open result: ${title} first`,
  "Open linked results and decide which ships",
])("keeps meaningful reason %j", (attentionReason) => {
  expect(projectTodoAttentionDetail({ title, attentionReason })).toBe(attentionReason);
});

it("has no detail without a reason", () => {
  expect(projectTodoAttentionDetail({ title })).toBeUndefined();
});

it("names the to-do even for long legacy titles", () => {
  const long = `Give the sidebar visual hierarchy ${"and more detail ".repeat(10)}`.trim();
  const reason = projectTodoResultAttentionReason(long);
  expect(reason.length).toBeLessThanOrEqual(80);
  expect(reason.startsWith("Open result: Give the sidebar visual hierarchy")).toBe(true);
  expect(reason.endsWith("…")).toBe(true);
  expect(projectTodoAttentionDetail({ title: long, attentionReason: reason })).toBeUndefined();
});
