/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { BotIcon, SparkleIcon, UserIcon } from "../../../src/renderer/components/ui/icons";
import { SessionPurposeIndicator } from "../../../src/renderer/components/ui/session-purpose-indicator";
import { sessionIdentityIcons } from "../../../src/renderer/lib/session-identity";

afterEach(cleanup);

it.each([
  ["user", "User Session", UserIcon],
  ["delegated", "Delegated Session", BotIcon],
  ["subagent", "Subagent", SparkleIcon],
] as const)("reuses the established %s glyph and accessible identity", (purpose, label, Icon) => {
  const view = render(<SessionPurposeIndicator purpose={purpose} />);
  expect(sessionIdentityIcons[purpose]).toBe(Icon);
  expect(screen.getByRole("img", { name: label }).getAttribute("title")).toBe(label);
  expect(view.container.querySelector("svg")?.outerHTML).toBe(renderToStaticMarkup(<Icon />));
});
