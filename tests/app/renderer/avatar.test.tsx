import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Avatar } from "../../../src/renderer/components/ui/avatar";

describe("Avatar", () => {
  it("renders deterministic but distinct Project and Session styles", () => {
    const firstSession = renderToStaticMarkup(<Avatar kind="session" seed="stable-seed" />);
    const secondSession = renderToStaticMarkup(<Avatar kind="session" seed="stable-seed" />);
    const project = renderToStaticMarkup(<Avatar kind="project" seed="stable-seed" />);

    expect(firstSession).toBe(secondSession);
    expect(project).not.toBe(firstSession);
  });

  it("renders Project avatars without a border or generated background", () => {
    const markup = renderToStaticMarkup(<Avatar kind="project" seed="project" />);
    const source = markup.match(/src="([^"]+)"/)?.[1];

    expect(markup).not.toContain("border");
    expect(markup).not.toContain("bg-muted");
    expect(source).toBeDefined();
    expect(decodeURIComponent(source!)).toContain('<rect width="100" height="100" rx="0" ry="0"/>');
  });

  it("colors the Session emoji itself from its workflow status without a ring", () => {
    const markup = renderToStaticMarkup(
      <Avatar kind="session" seed="session" statusColor="violet" />,
    );

    expect(markup).toContain("text-workflow-violet");
    expect(markup).toContain('fill="currentColor"');
    expect(markup).not.toContain("border");
    expect(markup).not.toContain("bg-workflow-violet");
  });

  it("uses a neutral color when a Session has no workflow status", () => {
    const markup = renderToStaticMarkup(<Avatar kind="session" seed="session" />);

    expect(markup).toContain("text-muted-foreground");
    expect(markup).toContain('fill="currentColor"');
  });
});
