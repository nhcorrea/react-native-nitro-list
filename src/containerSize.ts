export function nextContainerSize(
  current: number,
  total: number,
  offset: number,
  viewport: number,
): number {
  if (current <= 0 || viewport <= 0) return total;
  if (offset + viewport * 3 >= Math.min(current, total)) return total;
  if (total > current) return total + Math.max(viewport * 2, total * 0.1);
  return current;
}
