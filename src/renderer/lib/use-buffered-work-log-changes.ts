import { useEffect, useRef, useState } from "react";
import type { WorkLogChangeChunk } from "../../utils/turn-diff";

const STREAMING_DIFF_MAX_WAIT_MS = 120;
const STREAMING_DIFF_CHARACTER_THRESHOLD = 200;

function sameChange(left: WorkLogChangeChunk | undefined, right: WorkLogChangeChunk) {
  return (
    left?.path === right.path && left.diff === right.diff && left.streaming === right.streaming
  );
}

function lineCount(value: string) {
  let count = 1;
  for (const character of value) if (character === "\n") count++;
  return count;
}

/**
 * Coalesces token-sized live diff updates while preserving immediate settled changes.
 * Complete lines and larger chunks remain responsive; a short deadline prevents a
 * slowly growing final line from appearing stuck.
 */
export function useBufferedWorkLogChanges(changes: WorkLogChangeChunk[]): WorkLogChangeChunk[] {
  const [displayed, setDisplayed] = useState(changes);
  const displayedRef = useRef(displayed);
  const latestRef = useRef(changes);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const publish = (next: WorkLogChangeChunk[]) => {
    displayedRef.current = next;
    setDisplayed(next);
  };

  useEffect(() => {
    latestRef.current = changes;
    const previousById = new Map(displayedRef.current.map((change) => [change.id, change]));
    const changed = changes.some((change) => !sameChange(previousById.get(change.id), change));
    const removed = displayedRef.current.some(
      (change) => !changes.some((candidate) => candidate.id === change.id),
    );
    if (!changed && !removed) return;

    const streamingChanges = changes.filter((change) => change.streaming);
    const shouldPublishStreaming = streamingChanges.some((change) => {
      const previous = previousById.get(change.id);
      if (!previous) return true;
      return (
        Math.abs(change.diff.length - previous.diff.length) >= STREAMING_DIFF_CHARACTER_THRESHOLD ||
        lineCount(change.diff) > lineCount(previous.diff)
      );
    });
    const settledChanged = changes.some(
      (change) => !change.streaming && !sameChange(previousById.get(change.id), change),
    );

    if (shouldPublishStreaming || settledChanged || streamingChanges.length === 0 || removed) {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      timerRef.current = undefined;
      publish(changes);
      return;
    }

    if (timerRef.current === undefined) {
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined;
        publish(latestRef.current);
      }, STREAMING_DIFF_MAX_WAIT_MS);
    }
  }, [changes]);

  useEffect(
    () => () => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    },
    [],
  );

  return displayed;
}
