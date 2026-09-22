import { Store } from "r-state-tree";
import type {
  DrawControl,
  DrawControlInvocation,
  DrawControlResponse,
} from "../../domain/draw/draw-control";
import type { ProjectSessionStore } from "./ProjectSessionStore";

export interface DrawControlStoreProps {
  sessions(): readonly ProjectSessionStore[];
  findSession(sessionId: string): ProjectSessionStore | undefined;
  isResolved(sessionId: string): boolean;
  activeSessionId(): string | undefined;
  openActiveDraw(): Promise<void>;
}

/** Owns window-local Draw control registration and dispatch for loaded Project Sessions. */
export class DrawControlStore extends Store<DrawControlStoreProps> {
  private readonly controls = new Map<string, DrawControl>();

  constructor(props: DrawControlStore["props"]) {
    super(props);
    this.effect(() => {
      const unregister = this.props.sessions().map((session) =>
        this.register({
          sessionId: session.sessionId,
          invoke: (invocation, signal) => this.invokeSession(session.sessionId, invocation, signal),
        }),
      );
      return () => {
        for (const dispose of unregister) dispose();
      };
    });
  }

  register(control: DrawControl) {
    this.controls.set(control.sessionId, control);
    return () => {
      if (this.controls.get(control.sessionId) === control) this.controls.delete(control.sessionId);
    };
  }

  async invoke(
    sessionId: string,
    invocation: DrawControlInvocation,
    signal?: AbortSignal,
  ): Promise<DrawControlResponse> {
    const control = this.controls.get(sessionId);
    if (!control)
      return {
        ok: false,
        code: "DRAW_MODE_REQUIRED",
        message: "Enter Cake Draw for this Project Session, then retry.",
      };
    return control.invoke(invocation, signal);
  }

  private async enterDraw(session: ProjectSessionStore) {
    if (this.props.activeSessionId() === session.sessionId) await this.props.openActiveDraw();
    else {
      session.showPresentation("draw");
      await session.drawStore.initialize();
    }
  }

  private async invokeSession(
    sessionId: string,
    invocation: DrawControlInvocation,
    signal?: AbortSignal,
  ): Promise<DrawControlResponse> {
    const cancelled = (): DrawControlResponse => ({
      ok: false,
      code: "REQUEST_CANCELLED",
      message: "The Draw request was cancelled.",
    });
    if (signal?.aborted) return cancelled();
    const session = this.props.findSession(sessionId);
    if (!session)
      return {
        ok: false,
        code: "SESSION_NOT_VISIBLE",
        message: "This Project Session is not loaded in the invoking Cake window.",
      };
    if (this.props.isResolved(sessionId))
      return {
        ok: false,
        code: "SESSION_RESOLVED",
        message: "Resolved Project Sessions cannot change a whiteboard.",
      };
    if (invocation._tag === "Enter") {
      await this.enterDraw(session);
      if (signal?.aborted) return cancelled();
      const board = session.drawStore.activeBoard;
      return board
        ? { ok: true, kind: "entered", board, scene: await session.drawStore.read("viewport") }
        : { ok: false, code: "BOARD_NOT_OPEN", message: "No whiteboard is open." };
    }
    if (invocation._tag === "Open") {
      await this.enterDraw(session);
      if (signal?.aborted) return cancelled();
      const draw = session.drawStore;
      if (!draw.boards.some((board) => board.id === invocation.boardId))
        return {
          ok: false,
          code: "BOARD_NOT_OPEN",
          message: "That whiteboard does not exist in this Project Session.",
        };
      await draw.selectBoard(invocation.boardId);
      const board = draw.activeBoard;
      return board
        ? { ok: true, kind: "opened", board, scene: await draw.read("viewport") }
        : { ok: false, code: "BOARD_NOT_OPEN", message: "That whiteboard is not open." };
    }
    if (session.presentationMode !== "draw")
      return {
        ok: false,
        code: "DRAW_MODE_REQUIRED",
        message: "Enter Cake Draw for this Project Session, then retry.",
      };
    const draw = session.drawStore;
    if (!draw.activeBoard || (invocation.boardId && invocation.boardId !== draw.activeBoard.id))
      return {
        ok: false,
        code: "BOARD_NOT_OPEN",
        message: "Open the requested whiteboard before using it.",
      };
    try {
      switch (invocation._tag) {
        case "Read":
          return {
            ok: true,
            kind: "read",
            boardId: draw.activeBoard.id,
            scene: await draw.read(invocation.scope),
          };
        case "Render":
          return {
            ok: true,
            kind: "rendered",
            boardId: draw.activeBoard.id,
            render: await draw.render(invocation),
          };
        case "ExportDocument":
          return {
            ok: true,
            kind: "exported-document",
            boardId: draw.activeBoard.id,
            document: await draw.exportDocument(),
          };
        case "Apply": {
          const receipt = await draw.apply(invocation.operations);
          const checkpointId = draw.lastCheckpointId;
          if (!checkpointId) throw new Error("Cake Draw did not create an agent checkpoint");
          if (signal?.aborted)
            return {
              ok: false,
              code: "APPLY_OUTCOME_UNKNOWN",
              message: "The request was cancelled while the Draw batch was being saved.",
            };
          return {
            ok: true,
            kind: "applied",
            boardId: draw.activeBoard.id,
            checkpointId,
            receipt,
            scene: await draw.read("page"),
          };
        }
        case "Clear": {
          const receipt = await draw.clear();
          const checkpointId = draw.lastCheckpointId;
          if (!checkpointId) throw new Error("Cake Draw did not create an agent checkpoint");
          return {
            ok: true,
            kind: "cleared",
            boardId: draw.activeBoard.id,
            checkpointId,
            receipt,
            scene: await draw.read("page"),
          };
        }
        case "Undo": {
          const result = await draw.undo(invocation.checkpointId);
          return {
            ok: true,
            kind: "undone",
            boardId: draw.activeBoard.id,
            checkpointId: result.checkpointId,
            receipt: result.receipt,
            scene: await draw.read("page"),
          };
        }
        case "Mermaid": {
          const receipt = await draw.insertMermaid(invocation.diagram, {
            id: invocation.id,
            replace: invocation.replace,
          });
          const checkpointId = draw.lastCheckpointId;
          if (!checkpointId) throw new Error("Cake Draw did not create an agent checkpoint");
          if (signal?.aborted)
            return {
              ok: false,
              code: "APPLY_OUTCOME_UNKNOWN",
              message: "The request was cancelled while the Mermaid diagram was being saved.",
            };
          return {
            ok: true,
            kind: "mermaid",
            boardId: draw.activeBoard.id,
            checkpointId,
            diagramId: receipt.diagramId,
            elementCount: receipt.elementCount,
            mappings: receipt.mappings,
            scene: await draw.read("page"),
          };
        }
      }
    } catch (error) {
      return {
        ok: false,
        code: "INVALID_REQUEST",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
