import { describe, expect, it } from "vitest";
import {
  promptText,
  parseContextAttachmentBlocks,
} from "../../../../src/services/pi/runtime/session-projection";

describe("promptText file attachments", () => {
  it("preserves whitespace in file paths and projects compact attachments rather than backend paths as user text", () => {
    for (const path of ["/device/My Files/sample.txt", "/server/cache/accepted/id"]) {
      const attachment = { kind: "file" as const, name: "sample.txt", path };
      const content = promptText("Inspect", [attachment]);
      expect(content).toContain(JSON.stringify(attachment));
      expect(parseContextAttachmentBlocks(content)).toEqual({
        text: "Inspect",
        attachments: [attachment],
      });
    }
  });
});
