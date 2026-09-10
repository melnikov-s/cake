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

  it("uses the workflow color on Session avatar presentation", () => {
    const markup = renderToStaticMarkup(
      <Avatar kind="session" seed="session" statusColor="violet" />,
    );

    expect(markup).toContain("bg-workflow-violet/65");
  });
});
