import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import type { SystemMessage } from "@earendil-works/pi-ai";

function body(name: string, section: string): string {
  const opening = `<${name}>\n`;
  const closing = `\n</${name}>`;
  return section.startsWith(opening) && section.endsWith(closing)
    ? section.slice(opening.length, -closing.length)
    : section;
}

function section(prompt: string, name: string): string | undefined {
  return prompt.match(new RegExp(`^<${name}>\\n[\\s\\S]*?^<\\/${name}>`, "m"))?.[0];
}

const worktreeBlock = /<worktree_instructions>\n[\s\S]*?\n<\/worktree_instructions>/g;

function withoutWorktree(text: string): string {
  return text
    .replace(worktreeBlock, "")
    .replace(/\n{2,}(?=<\/session_instructions>)/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A checkout relocation is not a new instruction source. Keep equivalent inherited
 * sections byte-for-byte so Pi's ordinary diff does not redeclare them. Real content
 * changes still use Pi's normal replacement policy. No transcript entries are edited.
 */
export function retainRelocatedForkContext(
  event: BeforeAgentStartEvent,
  inherited: SystemMessage,
): void {
  const previous = inherited.sections;
  if (!previous) return;
  const options = event.systemPromptOptions;
  // Persist the original path mapping in an ordinary small system section so reopen,
  // compaction, and subsequent forks do not require an in-memory context cache.
  const sourceCwds = [
    ...new Set([
      ...Array.from(
        previous.fork_paths?.matchAll(/<source_cwd>\n([^\n]+)\n<\/source_cwd>/g) ?? [],
        (match) => match[1]!,
      ),
      ...(previous.cwd ? [body("cwd", previous.cwd)] : []),
    ]),
  ]
    .filter((path) => path !== options.cwd)
    .sort((a, b) => b.length - a.length);
  if (sourceCwds.length === 0) return;
  for (const name of ["project_context", "skills"] as const) {
    const old = previous[name];
    const current = section(event.systemPrompt, name);
    if (!old || !current) continue;
    const currentLocations = new Set(
      Array.from(current.matchAll(/<location>([^<]+)<\/location>/g), (match) => match[1]!),
    );
    // Relocate source metadata only, never instruction prose or arbitrary absolute paths.
    const relocated = old.replace(
      name === "project_context"
        ? /<project_instructions path="([^"]+)">/g
        : /<location>([^<]+)<\/location>/g,
      (match, path: string) => {
        // Shared resources can live under the old cwd without moving with its checkout.
        if (name === "skills" && currentLocations.has(path)) return match;
        const source = sourceCwds.find((cwd) => path.startsWith(`${cwd}/`));
        return source ? match.replace(path, `${options.cwd}${path.slice(source.length)}`) : match;
      },
    );
    if (relocated !== current) continue;
    options.sections[name] = body(name, old);
  }
  options.sections.fork_paths = [
    "Inherited instruction-file and skill locations under the source checkouts refer to the corresponding paths in the current checkout. Resolve those inherited resource paths there; do not use the source checkouts for repository work.",
    ...sourceCwds.map((cwd) => `<source_cwd>\n${cwd}\n</source_cwd>`),
    `<current_cwd>\n${options.cwd}\n</current_cwd>`,
  ].join("\n\n");
  const oldAddendum = previous.addendum;
  const currentAddendum = section(event.systemPrompt, "addendum");
  if (!oldAddendum || !currentAddendum) return;
  if (
    withoutWorktree(body("addendum", oldAddendum)) !==
    withoutWorktree(body("addendum", currentAddendum))
  )
    return;
  options.sections.addendum = body("addendum", oldAddendum);
  const oldWorktree = oldAddendum.match(worktreeBlock) ?? [];
  const currentWorktree = currentAddendum.match(worktreeBlock) ?? [];
  if (oldWorktree.join("\n\n") !== currentWorktree.join("\n\n") || previous.fork_worktree) {
    options.sections.fork_worktree = [
      "The following replaces all inherited worktree instructions for this checkout.",
      currentWorktree.length
        ? currentWorktree.join("\n\n")
        : "This checkout has no worktree-specific instructions.",
    ].join("\n\n");
  }
}
