interface SearchableSession {
  sessionId: string;
  title: string;
  modifiedAt: string;
}

function normalize(text: string) {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Compact subsequences support abbreviations without matching scattered letters
 * across an arbitrarily long title. Literal matches always rank ahead of fuzzy ones. */
function fuzzyPenalty(title: string, token: string): number | undefined {
  if (token.length < 2) return undefined;
  let best: number | undefined;
  for (
    let start = title.indexOf(token[0]!);
    start !== -1;
    start = title.indexOf(token[0]!, start + 1)
  ) {
    let position = start;
    let matched = true;
    for (const character of token.slice(1)) {
      position = title.indexOf(character, position + 1);
      if (position === -1) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    const gaps = position - start + 1 - token.length;
    if (gaps > Math.max(12, token.length * 3)) continue;
    const penalty = gaps * 3 + start;
    best = best === undefined ? penalty : Math.min(best, penalty);
  }
  return best;
}

function rank(title: string, query: string): readonly [number, number] | undefined {
  if (!query) return [0, 0];
  if (title === query) return [0, 0];
  if (title.startsWith(query)) return [1, 0];
  const phraseIndex = title.indexOf(query);
  if (phraseIndex !== -1) return [2, phraseIndex];
  let fuzzy = false;
  let penalty = 0;
  for (const token of query.split(" ")) {
    const index = title.indexOf(token);
    if (index !== -1) {
      penalty += index;
      continue;
    }
    const match = fuzzyPenalty(title, token);
    if (match === undefined) return undefined;
    fuzzy = true;
    penalty += match;
  }
  return [fuzzy ? 4 : 3, penalty];
}

/** Pure deterministic title search; equal matches and empty queries use recency. */
export function searchSessions<T extends SearchableSession>(
  sessions: readonly T[],
  query: string,
): T[] {
  const normalizedQuery = normalize(query);
  return sessions
    .flatMap((session) => {
      const score = rank(normalize(session.title), normalizedQuery);
      return score ? [{ session, score }] : [];
    })
    .sort(
      (left, right) =>
        left.score[0] - right.score[0] ||
        left.score[1] - right.score[1] ||
        right.session.modifiedAt.localeCompare(left.session.modifiedAt) ||
        left.session.sessionId.localeCompare(right.session.sessionId),
    )
    .map(({ session }) => session);
}
