import * as drawBoards from "../../domain/draw/drawBoards";
import { DrawRpc } from "../protocol/DrawRpc";

export const drawHandlers = DrawRpc.of({
  "draw.list": (input) => drawBoards.list(input),
  "draw.create": (input) => drawBoards.create(input),
  "draw.read": (input) => drawBoards.read(input),
  "draw.save": (input) => drawBoards.save(input),
  "draw.rename": (input) => drawBoards.rename(input),
  "draw.delete": (input) => drawBoards.deleteBoard(input),
});
