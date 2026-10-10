// E148
export type ParsedIp = { bits: number; value: bigint };
export function parseIp(text: string): ParsedIp | null;
export function parseIpRange(text: string): (ParsedIp & { prefix: number }) | null;
export function ipAllowed(address: string, entries: readonly string[]): boolean;
export function allowlistFromLines(text: string): string[] | null;
