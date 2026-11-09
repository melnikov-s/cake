/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  ArtifactIcon,
  BackIcon,
  BranchIcon,
  BrowserIcon,
  CakeIcon,
  ChatIcon,
  ChatSidebarIcon,
  CopyIcon,
  DockBottomIcon,
  FolderPlusIcon,
  LightningIcon,
  MarkdownIcon,
  MergeResolveIcon,
  MoveTopIcon,
  NetworkIcon,
  PaperclipIcon,
  PlusIcon,
  ReplyIcon,
  SettingsIcon,
  SidebarIcon,
  TerminalIcon,
  VsCodeIcon,
} from "../../../src/renderer/components/ui/icons";
import { IconButton } from "../../../src/renderer/components/ui/icon-button";
import { IconSizeProvider, iconSizes } from "../../../src/renderer/components/ui/icon-size";
import { Button } from "../../../src/renderer/components/ui/button";
import { NumberedIconButton } from "../../../src/renderer/components/ui/numbered-icon-button";
import { WorkspaceModeControls } from "../../../src/renderer/components/workspace-mode-controls";
import { StatusDot } from "../../../src/renderer/components/ui/status-dot";

afterEach(cleanup);

const glyphs = {
  ArtifactIcon,
  BackIcon,
  BranchIcon,
  BrowserIcon,
  CakeIcon,
  ChatIcon,
  ChatSidebarIcon,
  CopyIcon,
  DockBottomIcon,
  FolderPlusIcon,
  LightningIcon,
  MarkdownIcon,
  MergeResolveIcon,
  MoveTopIcon,
  NetworkIcon,
  PaperclipIcon,
  PlusIcon,
  ReplyIcon,
  SettingsIcon,
  SidebarIcon,
  TerminalIcon,
  VsCodeIcon,
};

it.each(Object.entries(glyphs))(
  "%s uses the control's semantic box, including embedded SVG",
  (_name, Glyph) => {
    for (const [role, dimension] of Object.entries(iconSizes)) {
      const view = render(
        <IconButton tooltip="Control" iconSize={role as keyof typeof iconSizes}>
          <Glyph />
        </IconButton>,
      );
      const svg = view.container.querySelector("svg")!;
      expect(svg.getAttribute("width")).toBe(String(dimension));
      expect(svg.getAttribute("height")).toBe(String(dimension));
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      const button = view.getByRole("button", { name: "Control" });
      expect(button.classList.contains("size-7")).toBe(true);
      expect(button.className).toContain("[@media(pointer:coarse)]:min-h-11");
      expect(button.className).toContain("[@media(pointer:coarse)]:min-w-11");
      view.unmount();
    }
  },
);

it("inherits inline action roles but allows explicit navigation, leaving non-glyph SVGs and status dots alone", () => {
  const view = render(
    <IconSizeProvider size="inline">
      <IconButton tooltip="Attach">
        <PaperclipIcon />
      </IconButton>
      <Button aria-label="Copy">
        <CopyIcon />
      </Button>
      <IconButton tooltip="Navigate" iconSize="navigation">
        <CakeIcon />
      </IconButton>
      <IconButton tooltip="Artwork">
        <svg width="30" height="30" />
      </IconButton>
      <StatusDot data-testid="status" status="running" size="sm" />
    </IconSizeProvider>,
  );
  for (const name of ["Attach", "Copy"])
    expect(view.getByRole("button", { name }).querySelector("svg")!.getAttribute("width")).toBe(
      "12",
    );
  expect(
    view.getByRole("button", { name: "Navigate" }).querySelector("svg")!.getAttribute("width"),
  ).toBe("18");
  expect(
    view.getByRole("button", { name: "Artwork" }).querySelector("svg")!.getAttribute("width"),
  ).toBe("30");
  expect(view.getByTestId("status").className).toContain("size-[6px]");
  expect(view.getByTestId("status").className).toContain("bg-accent");
});

it("reserves the existing badge/target track independently of the navigation glyph", () => {
  const view = render(
    <NumberedIconButton count={1000} tooltip="Artifacts">
      <ArtifactIcon />
    </NumberedIconButton>,
  );
  const svg = view.container.querySelector("svg")!;
  expect(svg.getAttribute("width")).toBe("18");
  expect(svg.parentElement!.classList.contains("size-6")).toBe(true);
  expect(view.getByText("1000").classList.contains("min-w-3.5")).toBe(true);
});

it("only the three view controls are 24px, retaining pressed states and handlers", () => {
  const main = vi.fn(),
    code = vi.fn(),
    browser = vi.fn(),
    terminal = vi.fn();
  const view = render(
    <WorkspaceModeControls
      mode="normal"
      terminalAvailable
      terminalOpen={false}
      onBackToAgent={main}
      onOpenIde={code}
      onOpenBrowser={browser}
      onToggleTerminal={terminal}
    />,
  );
  for (const [name, handler] of [
    ["Main", main],
    ["VS Code", code],
    ["Browser", browser],
    ["Terminal", terminal],
  ] as const) {
    const button = view.getByRole("button", { name });
    expect(button.querySelector("svg")!.getAttribute("width")).toBe(
      name === "Terminal" ? "18" : "24",
    );
    expect(button.getAttribute("aria-pressed")).toBe(String(name === "Main"));
    fireEvent.click(button);
    expect(handler).toHaveBeenCalledOnce();
  }
});
