export const diagramSourceLimit = 50_000;
export const diagramOutputLimit = 2_000_000;
export const diagramEdgeLimit = 1_000;
export const diagramTimeoutMs = 5_000;
export const diagramStreamingIdleTimeoutMs = 30_000;

export interface DiagramRequest {
  source: string;
  maxWidth: number;
  fontFamily: string;
  fontFamilyMono: string;
  idPrefix: string;
}
export type DiagramResponse = { svg: string; error?: never } | { svg?: never; error: string };
