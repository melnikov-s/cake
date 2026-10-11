export function nativeBuildMode(environment?: { CAKE_BUILD_MODE?: string }): "full" | "slim";

export function buildNativeAssets(
  output: string,
  runScript: (script: string, output: string) => Promise<void>,
  environment?: { CAKE_BUILD_MODE?: string },
): Promise<void>;
