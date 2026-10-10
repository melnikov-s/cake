export function swiftBuildIdentity(): Promise<string>;

export function buildNativeBundle(options: {
  packagePath: string;
  product: string;
  output: string;
  inputs: readonly string[];
  buildIdentity: string;
  build(bundleDirectory: string): Promise<void>;
  force?: boolean;
}): Promise<void>;
