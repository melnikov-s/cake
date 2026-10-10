export function renderCakePrompt(
  template: string,
  values: { readonly target: string; readonly files?: ReadonlyArray<string> },
): string {
  const files = values.files?.length
    ? values.files.map((file) => `- ${file}`).join("\n")
    : "- Run `git status` to list the conflicted files.";
  return template.replaceAll("{{target}}", values.target).replaceAll("{{files}}", files);
}
