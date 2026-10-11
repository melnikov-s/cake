export function swiftBuildIdentity(): Promise<string>;

export function buildNativeBundle(options: {
  product: string;
  output: string;
  inputs: readonly string[];
  buildIdentity: string;
  build(bundleDirectory: string, scratchDirectory: string): Promise<void>;
  force?: boolean;
  cacheRoot?: string;
}): Promise<void>;
