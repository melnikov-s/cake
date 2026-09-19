import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  DrawBoardCreateInput,
  DrawBoardDocument,
  DrawBoardError,
  DrawBoardListInput,
  DrawBoardMetadata,
  DrawBoardRenameInput,
  DrawBoardSaveInput,
  DrawBoardTarget,
} from "../../domain/draw/draw-board-data";

export const DrawRpc = RpcGroup.make(
  Rpc.make("draw.list", {
    payload: DrawBoardListInput,
    success: Schema.Array(DrawBoardMetadata),
    error: DrawBoardError,
  }),
  Rpc.make("draw.create", {
    payload: DrawBoardCreateInput,
    success: DrawBoardMetadata,
    error: DrawBoardError,
  }),
  Rpc.make("draw.read", {
    payload: DrawBoardTarget,
    success: DrawBoardDocument,
    error: DrawBoardError,
  }),
  Rpc.make("draw.save", {
    payload: DrawBoardSaveInput,
    success: DrawBoardMetadata,
    error: DrawBoardError,
  }),
  Rpc.make("draw.rename", {
    payload: DrawBoardRenameInput,
    success: DrawBoardMetadata,
    error: DrawBoardError,
  }),
  Rpc.make("draw.delete", {
    payload: DrawBoardTarget,
    success: Schema.Void,
    error: DrawBoardError,
  }),
);
