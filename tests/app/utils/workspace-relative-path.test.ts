import { describe, expect, it } from "vitest";
import { toWorkspaceRelativePath } from "../../../src/utils/workspace-relative-path";

describe("toWorkspaceRelativePath", () => {
  const workspace = "/Users/user/dev/cake";

  it("keeps already relative paths unchanged", () => {
    expect(toWorkspaceRelativePath("src/modelMeta.ts", workspace)).toBe("src/modelMeta.ts");
    expect(toWorkspaceRelativePath("./src/Model.ts")).toBe("src/Model.ts");
  });

  it("relativizes absolute paths inside the workspace", () => {
    expect(toWorkspaceRelativePath(`${workspace}/src/identity.ts`, workspace)).toBe(
      "src/identity.ts",
    );
  });

  it("keeps absolute paths outside the workspace absolute", () => {
    expect(toWorkspaceRelativePath("/src/modelMeta.ts", workspace)).toBe("/src/modelMeta.ts");
  });

  it("normalizes windows separators", () => {
    expect(toWorkspaceRelativePath("C:\\repo\\src\\app.ts", "C:/repo")).toBe("src/app.ts");
  });

  it("trims whitespace and leaves foreign absolute paths untouched apart from trimming", () => {
    expect(toWorkspaceRelativePath("  src/a.md  ", workspace)).toBe("src/a.md");
    expect(toWorkspaceRelativePath("/etc/hosts", workspace)).toBe("/etc/hosts");
  });
});
