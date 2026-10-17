import { Context } from "effect";

export interface CakeChatLocation {
  readonly workingDirectory: string;
  readonly sessionDirectory: string;
}

/** Process configuration; project identities and locations are resolved by domain policy. */
export interface CakeChatRuntimeConfiguration {
  readonly location: CakeChatLocation;
  readonly agentDirectory: string;
}

export class CakeChatConfiguration extends Context.Service<
  CakeChatConfiguration,
  CakeChatRuntimeConfiguration
>()("cake/services/pi-durable/CakeChatConfiguration") {}
