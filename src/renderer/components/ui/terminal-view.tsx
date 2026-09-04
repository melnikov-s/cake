import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { cn } from "@/lib/utils";

export interface TerminalViewProps {
  className?: string;
  active?: boolean;
  onData(data: string): void;
  onNewTab(): void;
  onResize(cols: number, rows: number): void;
  subscribe(listener: (data: string) => void): () => void;
}

function terminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--background").trim(),
    foreground: styles.getPropertyValue("--foreground").trim(),
    cursor: styles.getPropertyValue("--accent").trim(),
    selectionBackground: styles.getPropertyValue("--accent").trim(),
  };
}

/** Shared xterm-backed interactive terminal surface. */
export function TerminalView({
  className,
  active = true,
  onData,
  onNewTab,
  onResize,
  subscribe,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal>(null);
  const fitRef = useRef<FitAddon>(null);
  const callbacksRef = useRef({ onData, onNewTab, onResize, subscribe });
  callbacksRef.current = { onData, onNewTab, onResize, subscribe };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    terminalRef.current = terminal;
    fitRef.current = fit;
    terminal.loadAddon(fit);
    terminal.open(host);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || !event.metaKey || event.key.toLowerCase() !== "t")
        return true;
      event.preventDefault();
      callbacksRef.current.onNewTab();
      return false;
    });
    const fitTerminal = () => {
      if (!host.isConnected || host.clientWidth === 0 || host.clientHeight === 0) return;
      fit.fit();
      callbacksRef.current.onResize(terminal.cols, terminal.rows);
    };
    const resizeObserver = new ResizeObserver(fitTerminal);
    resizeObserver.observe(host);
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = terminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const dataSubscription = terminal.onData((data) => callbacksRef.current.onData(data));
    const unsubscribe = callbacksRef.current.subscribe((data) => terminal.write(data));
    requestAnimationFrame(() => {
      fitTerminal();
      terminal.focus();
    });
    return () => {
      unsubscribe();
      dataSubscription.dispose();
      themeObserver.disconnect();
      resizeObserver.disconnect();
      terminalRef.current = null;
      fitRef.current = null;
      terminal.dispose();
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      const terminal = terminalRef.current;
      const host = hostRef.current;
      if (!terminal || !host?.isConnected || host.clientWidth === 0 || host.clientHeight === 0)
        return;
      fitRef.current?.fit();
      callbacksRef.current.onResize(terminal.cols, terminal.rows);
      terminal.focus();
    });
  }, [active]);

  return <div ref={hostRef} className={cn("h-full min-h-0 w-full min-w-0", className)} />;
}
