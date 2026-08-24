import { Markdown } from "@/components/ai-elements/markdown";
import { Message } from "@/components/ai-elements/message";
import { SkillIcon } from "./ui/icons";
import type { UiPart } from "../../ipc/session-contract";

export function SkillMessage({ part }: { part: Extract<UiPart, { kind: "skill" }> }) {
  return (
    <Message className="mr-auto w-[min(100%,42rem)]">
      <details className="group min-w-0">
        <summary
          className="inline-flex max-w-full items-center gap-[7px] rounded-[999px] border border-[color-mix(in_oklab,var(--accent)_30%,var(--border))] bg-[color-mix(in_oklab,var(--card)_88%,var(--accent))] px-[11px] py-[7px] font-mono text-[11px] leading-[normal] font-normal text-muted-foreground list-none cursor-pointer hover:border-[color-mix(in_oklab,var(--accent)_55%,var(--border))] hover:text-foreground [&::-webkit-details-marker]:hidden [&_svg]:flex-none [&_svg]:text-accent"
          aria-label={`Skill loaded: ${part.name}`}
        >
          <SkillIcon />
          <span>Skill loaded</span>
          <strong className="truncate text-foreground">{part.name}</strong>
          <span className="text-[10px] text-muted-foreground group-open:hidden">View contents</span>
        </summary>
        <div className="mt-2 max-h-[32rem] overflow-auto rounded-[12px] border border-border bg-card px-4 py-[14px] text-[0.88rem]">
          <Markdown>{part.content}</Markdown>
        </div>
      </details>
    </Message>
  );
}
