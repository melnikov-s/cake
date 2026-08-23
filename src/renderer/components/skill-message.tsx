import { Markdown } from "@/components/ai-elements/markdown";
import { Message } from "@/components/ai-elements/message";
import type { UiPart } from "../../ipc/session-contract";

export function SkillMessage({ part }: { part: Extract<UiPart, { kind: "skill" }> }) {
  return (
    <Message className="skill-message mr-auto">
      <details>
        <summary aria-label={`Skill loaded: ${part.name}`}>
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4z" />
            <path d="m18.5 14 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
          </svg>
          <span>Skill loaded</span>
          <strong>{part.name}</strong>
          <span className="skill-message-hint">View contents</span>
        </summary>
        <div className="skill-message-content">
          <Markdown>{part.content}</Markdown>
        </div>
      </details>
    </Message>
  );
}
