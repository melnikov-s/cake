export interface VisualCaptureResult {
  readonly schemaVersion: 1;
  readonly scenario: string;
  readonly state: string;
  readonly dimensions: {
    readonly width: number;
    readonly height: number;
  };
  readonly outputPath: string;
  readonly mimeType: "image/png";
  readonly checksum: `sha256:${string}`;
}

export const visualCaptureResultPrefix = "VISUAL_CAPTURE_RESULT ";

export function formatVisualCaptureResult(result: VisualCaptureResult) {
  return `${visualCaptureResultPrefix}${JSON.stringify(result)}`;
}

export function parsePngDimensions(buffer: Buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== signature)
    throw new Error("Capture did not produce a valid PNG");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
