import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { ArtifactError } from "../../domain/artifact-data";
import {
  artifactEventSchema,
  cakeRpcPayloadSchemas,
  cakeRpcSuccessSchemas,
} from "../cake-rpc-contract";

type ArtifactOperation = keyof Pick<
  typeof cakeRpcPayloadSchemas,
  "respond-artifact" | "respond-ui" | "export-artifacts"
>;

const artifactRpc = <Type extends ArtifactOperation>(type: Type) =>
  Rpc.make(`artifacts.${type}` as const, {
    payload: cakeRpcPayloadSchemas[type],
    success: cakeRpcSuccessSchemas[type],
    error: ArtifactError,
  });

export const ArtifactRpc = RpcGroup.make(
  artifactRpc("respond-artifact"),
  artifactRpc("respond-ui"),
  artifactRpc("export-artifacts"),
  Rpc.make("artifacts.observeEvents", { success: artifactEventSchema, stream: true }),
);
