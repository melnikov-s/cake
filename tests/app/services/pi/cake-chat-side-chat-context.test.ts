import { describe, expect, it } from "vitest";
import {
  cakeChatSideChatSystemPrompt,
  renderCakeChatBranchContext,
} from "../../../../src/services/pi/runtime/sidecar-runtime";

describe("Cake Chat side chat context", () => {
  it("keeps the newest messages when the branch context exceeds its bound", () => {
    const long = "x".repeat(50_000);
    const context = renderCakeChatBranchContext([
      { role: "user", text: `oldest ${long}` },
      { role: "assistant", text: `middle ${long}` },
      { role: "user", text: `newer ${long}` },
      { role: "assistant", text: "branch point" },
    ]);
    expect(context).toMatch(/^\(1 earlier messages omitted\.\)/);
    expect(context).not.toContain("oldest");
    expect(context).toContain("## assistant\n\nbranch point");
  });

  it("frames a whole-message branch as tool-free discussion of the inlined conversation", () => {
    const prompt = cakeChatSideChatSystemPrompt(
      { entryId: "entry-1", selectedText: "", contextBefore: "", contextAfter: "" },
      "## assistant\n\nThe first task is larger.\n",
    );
    expect(prompt).toContain("You have no tools or Cake controls here.");
    expect(prompt).toContain("Branched from Cake Chat entry: entry-1");
    expect(prompt).toContain("branched from the whole final message");
    expect(prompt).toContain(
      "<cake-chat-conversation>\n## assistant\n\nThe first task is larger.\n</cake-chat-conversation>",
    );
  });

  it("quotes a selected passage instead of the whole-message notice", () => {
    const prompt = cakeChatSideChatSystemPrompt(
      { selectedText: "larger\nthan", contextBefore: "is ", contextAfter: " the second" },
      "",
    );
    expect(prompt).toContain("> larger\n> than");
    expect(prompt).not.toContain("whole final message");
  });
});
