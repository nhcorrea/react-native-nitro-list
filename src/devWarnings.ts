const IS_DEV = typeof __DEV__ !== 'undefined' && __DEV__;

const warnedIds = new Set<string>();

export function warnDevOnce(id: string, message: string): void {
  if (!IS_DEV || warnedIds.has(id)) return;
  warnedIds.add(id);
  console.warn(`[nitro-list] ${message}`);
}

export function clearWarnDevOnceForTests(): void {
  warnedIds.clear();
}
