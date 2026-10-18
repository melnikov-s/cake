import { Markdown } from "../ai-elements/markdown";
import { Callout } from "./callout";
import type { SourceLocation } from "../../../contracts/editor/source-location";

/** Application-delivered status and exact result links; no assistant relay is required. */
export function SessionResultNotice({
  text,
  onOpenSourceLocation,
}: {
  text: string;
  onOpenSourceLocation?(location: SourceLocation): void;
}) {
  return (
    <Callout role="status" aria-label="Session results" className="w-full min-w-0">
      <Markdown onOpenSourceLocation={onOpenSourceLocation}>{text}</Markdown>
    </Callout>
  );
}
