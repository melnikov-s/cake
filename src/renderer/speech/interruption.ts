export const INTERRUPTION_WINDOW_MS = 3000;

/** Acknowledgments are not requests for the floor; explicit leading commands are. */
export function isSpeechInterruption(text: string): boolean {
  const words = text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
  const first = words[0]?.toLowerCase();
  const command = first === "please" ? words[1]?.toLowerCase() : first;
  return words.length >= 4 || command === "stop" || command === "wait";
}
