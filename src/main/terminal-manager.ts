import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename } from "node:path";
import { spawn, type IPty } from "node-pty";

export type TerminalSessionKind = "project" | "cake-chat";

export type TerminalManagerEvent =
  | { type: "data"; ownerId: number; terminalId: string; data: string }
  | { type: "exit"; ownerId: number; terminalId: string; exitCode: number };

interface TerminalProcess {
  ownerId: number;
  kind: TerminalSessionKind;
  sessionId: string;
  shell: string;
  process: IPty;
}

/** Owns lazy session-scoped pseudo terminals and guarantees process cleanup. */
export class TerminalManager {
  private readonly terminals = new Map<string, TerminalProcess>();

  constructor(private readonly emit: (event: TerminalManagerEvent) => void) {}

  open(
    ownerId: number,
    target: { kind: TerminalSessionKind; sessionId: string },
    cwd: string,
    cols: number,
    rows: number,
  ) {
    const existing = [...this.terminals.entries()].find(
      ([, terminal]) =>
        terminal.ownerId === ownerId &&
        terminal.kind === target.kind &&
        terminal.sessionId === target.sessionId,
    );
    if (existing) return { terminalId: existing[0], shell: basename(existing[1].process.process) };

    const shell =
      process.env.SHELL ||
      (process.platform === "win32"
        ? process.env.COMSPEC || "powershell.exe"
        : process.platform === "darwin"
          ? "/bin/zsh"
          : "/bin/bash");
    const terminalId = randomUUID();
    const terminal = spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: cwd || homedir(),
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    this.terminals.set(terminalId, {
      ownerId,
      ...target,
      shell: normalizeProcessName(shell),
      process: terminal,
    });
    terminal.onData((data) => {
      for (let offset = 0; offset < data.length; offset += 262_144)
        this.emit({
          type: "data",
          ownerId,
          terminalId,
          data: data.slice(offset, offset + 262_144),
        });
    });
    terminal.onExit(({ exitCode }) => {
      this.terminals.delete(terminalId);
      this.emit({ type: "exit", ownerId, terminalId, exitCode });
    });
    return { terminalId, shell: basename(shell) };
  }

  write(ownerId: number, terminalId: string, data: string) {
    this.owned(ownerId, terminalId).process.write(data);
  }

  resize(ownerId: number, terminalId: string, cols: number, rows: number) {
    this.owned(ownerId, terminalId).process.resize(cols, rows);
  }

  hasRunningProgram(ownerId: number, terminalId: string) {
    const terminal = this.owned(ownerId, terminalId);
    return normalizeProcessName(terminal.process.process) !== terminal.shell;
  }

  close(ownerId: number, terminalId: string) {
    const terminal = this.owned(ownerId, terminalId);
    this.terminals.delete(terminalId);
    terminal.process.kill();
  }

  closeSession(kind: TerminalSessionKind, sessionId: string) {
    for (const [terminalId, terminal] of this.terminals) {
      if (terminal.kind !== kind || terminal.sessionId !== sessionId) continue;
      this.terminals.delete(terminalId);
      terminal.process.kill();
    }
  }

  closeOwner(ownerId: number) {
    for (const [terminalId, terminal] of this.terminals) {
      if (terminal.ownerId !== ownerId) continue;
      this.terminals.delete(terminalId);
      terminal.process.kill();
    }
  }

  disposeAll() {
    for (const terminal of this.terminals.values()) terminal.process.kill();
    this.terminals.clear();
  }

  private owned(ownerId: number, terminalId: string) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.ownerId !== ownerId) throw new Error("Terminal is unavailable");
    return terminal;
  }
}

function normalizeProcessName(name: string) {
  return basename(name.trim().replace(/^-/, ""))
    .toLowerCase()
    .replace(/\.exe$/, "");
}
