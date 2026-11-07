export const validationCommands: Record<string, { priority: number; steps: string[][] }>;
export function validationPriority(name: string, args: string[]): number;
