const promptVariablePattern = /{{\s*([A-Za-z][A-Za-z0-9]*)\s*}}/g;

export function renderPromptTemplate(
  template: string,
  values: Readonly<Record<string, string>> = {},
): string {
  const used = new Set<string>();
  const rendered = template.replace(promptVariablePattern, (_match, key: string) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Missing prompt template value: ${key}`);
    used.add(key);
    return values[key]!;
  });
  const unused = Object.keys(values).filter((key) => !used.has(key));
  if (unused.length > 0) throw new Error(`Unused prompt template values: ${unused.join(", ")}`);
  return rendered.trim();
}
