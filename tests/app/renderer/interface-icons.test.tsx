/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  ArtifactIcon,
  BackIcon,
  ChatSidebarIcon,
  DockBottomIcon,
  FolderPlusIcon,
  LightningIcon,
  MoveTopIcon,
  NetworkIcon,
  PlusIcon,
  SettingsIcon,
  SidebarIcon,
  TerminalIcon,
} from "../../../src/renderer/components/ui/icons";
import { NumberedIconButton } from "../../../src/renderer/components/ui/numbered-icon-button";

afterEach(cleanup);

it.each([
  ["Add project", FolderPlusIcon, 16],
  ["New session", PlusIcon, 16],
  ["Settings", SettingsIcon, 16],
  ["Artifacts", ArtifactIcon, 15],
  ["Automations", LightningIcon, 13],
  ["Back", BackIcon, 16],
  ["Sidebar", SidebarIcon, 16],
  ["Workspace", ChatSidebarIcon, 16],
  ["Terminal", TerminalIcon, 16],
  ["Sharing", NetworkIcon, 16],
  ["Dock", DockBottomIcon, 16],
  ["Move to top", MoveTopIcon, 16],
] as const)(
  "%s supports a 24px app glyph without inflating other consumers",
  (_name, Icon, originalSize) => {
    const view = render(<Icon />);
    expect(view.container.querySelector("svg")!.getAttribute("width")).toBe(String(originalSize));
    view.rerender(<Icon size={24} />);
    const svg = view.container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("24");
    expect(svg.getAttribute("height")).toBe("24");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
  },
);

it("reserves a 24px glyph track without resizing count badges", () => {
  const view = render(
    <NumberedIconButton count={1000} tooltip="Artifacts">
      <ArtifactIcon size={24} />
    </NumberedIconButton>,
  );
  const holder = view.container.querySelector("svg")!.parentElement!;
  expect(holder.classList.contains("size-6")).toBe(true);
  expect(view.getByText("1000").classList.contains("min-w-4")).toBe(true);
});
