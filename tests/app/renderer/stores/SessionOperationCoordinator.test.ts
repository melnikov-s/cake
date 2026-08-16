import { createStore, mount } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { SessionOperationCoordinator } from "../../../../src/renderer/stores/SessionOperationCoordinator";

describe("SessionOperationCoordinator", () => {
  it("owns workflow membership without synchronized Store-local id lists", () => {
    const operations = mount(createStore(SessionOperationCoordinator));
    const main = operations.start("main-chat");
    const settings = operations.start("settings");

    expect(operations.active("main-chat")).toEqual([main]);
    expect(operations.includes(settings, "main-chat")).toBe(false);
    expect(operations.active()).toEqual([main, settings]);

    operations.reset("main-chat");
    expect(operations.includes(main)).toBe(false);
    expect(operations.active("settings")).toEqual([settings]);
    operations[Symbol.dispose]();
  });
});
