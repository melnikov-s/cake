import type { SpeechInputPreferences } from "../../utils/speech-input-settings";

/** Acknowledgments are not requests for the floor; explicit leading commands are. */
export function isSpeechInterruption(
  text: string,
  policy: Pick<SpeechInputPreferences, "interruptionWords" | "shortCommands">,
): boolean {
  const words = text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
  const first = words[0]?.toLowerCase();
  const command = first === "please" ? words[1]?.toLowerCase() : first;
  return (
    words.length >= policy.interruptionWords ||
    (policy.shortCommands && (command === "stop" || command === "wait"))
  );
}
