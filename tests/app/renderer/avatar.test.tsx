// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Avatar } from "../../../src/renderer/components/ui/avatar";

describe("Avatar", () => {
  it("isolates SVG references when the same session appears more than once", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      <>
        <Avatar kind="session" seed="same" />
        <Avatar kind="session" seed="same" />
      </>,
    );
    const ids = Array.from(host.querySelectorAll("[id]"), (element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const svg of host.querySelectorAll("svg")) {
      const localIds = new Set(Array.from(svg.querySelectorAll("[id]"), (element) => element.id));
      for (const use of svg.querySelectorAll("use")) {
        expect(localIds.has(use.getAttribute("href")!.slice(1))).toBe(true);
      }
    }
  });

  it("materializes independently animatable eyes across generated body variants", () => {
    const shapes = new Set<string>();
    for (let seed = 0; seed < 60; seed++) {
      const host = document.createElement("div");
      host.innerHTML = renderToStaticMarkup(<Avatar kind="session" seed={String(seed)} animated />);
      const shape = host.querySelector('[id^="shape-"]')!;
      shapes.add(shape.id.split("-")[1]!);
      const character = host.querySelector(".dbga-hop")!;
      expect(character.querySelectorAll(".dbga-look")).toHaveLength(1);
      expect(character.querySelectorAll(".dbga-eye")).toHaveLength(2);
      expect(character.querySelectorAll("use")).toHaveLength(0);
      expect(character.querySelector('[fill="currentColor"]')).not.toBeNull();
    }
    expect(shapes.size).toBeGreaterThan(5);
  });

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

    expect(markup).toContain('data-workflow-status-color="#9a78d7"');
    expect(markup).toContain("data-workflow-status-color_type");
    expect(markup).toContain('fill="currentColor"');
    expect(markup).not.toContain("border");
    expect(markup).not.toContain("bg-current");
  });

  it("uses a neutral color when a Session has no workflow status", () => {
    const markup = renderToStaticMarkup(<Avatar kind="session" seed="session" />);

    expect(markup).toContain("text-muted-foreground");
    expect(markup).toContain('fill="currentColor"');
  });
});
