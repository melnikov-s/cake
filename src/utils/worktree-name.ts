export function suggestedWorktreeName(title: string) {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const suffix = crypto.randomUUID().slice(0, 6);
  return `${slug || "conversation"}-${suffix}`;
}
