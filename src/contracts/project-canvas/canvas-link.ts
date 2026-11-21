export interface CanvasTarget {
  readonly projectChatId: string;
  readonly cardId: string;
  readonly revision?: number;
}

export const canvasLink = ({ projectChatId, cardId, revision }: CanvasTarget) =>
  `cake://canvas/${projectChatId}/${cardId}${revision === undefined ? "" : `@r${revision}`}`;

export function parseCanvasLink(href: string): CanvasTarget | undefined {
  const match =
    /^cake:\/\/canvas\/(project-chat:[a-f0-9]{64})\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})(?:@r([1-9][0-9]*))?$/.exec(
      href,
    );
  if (!match?.[1] || !match[2]) return;
  const revision = match[3] ? Number(match[3]) : undefined;
  if (revision !== undefined && !Number.isSafeInteger(revision)) return;
  const target = { projectChatId: match[1], cardId: match[2] };
  return revision === undefined ? target : { ...target, revision };
}
