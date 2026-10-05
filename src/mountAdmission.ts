export const MOUNT_SLICE_BUDGET_MS = 5;
export const MOUNT_COST_PRIOR_MS = 2.5;
export const MOUNT_SLICE_MAX_ITEMS = 16;
export const MOUNT_ACK_TIMEOUT_MS = 80;
const COST_SMOOTHING = 0.3;

export function nextSliceSize(costPerItemMs: number, budgetMs = MOUNT_SLICE_BUDGET_MS): number {
  if (!(costPerItemMs > 0)) return MOUNT_SLICE_MAX_ITEMS;
  return Math.max(1, Math.min(MOUNT_SLICE_MAX_ITEMS, Math.floor(budgetMs / costPerItemMs)));
}

export function updateMountCost(previous: number, mountMs: number, items: number): number {
  if (!(items > 0) || !(mountMs >= 0)) return previous;
  const sample = mountMs / items;
  return previous + COST_SMOOTHING * (Math.max(sample, previous * 0.5) - previous);
}

type Waiter = {sequence: number; resolve: () => void; timer: ReturnType<typeof setTimeout> | null};

export class MountGate {
  available = false;
  costPerItemMs = MOUNT_COST_PRIOR_MS;
  private published = 0;
  private acknowledged = 0;
  private readonly sizes = new Map<number, number>();
  private waiters: Waiter[] = [];
  readonly mounted: (sequence: number, mountMs: number) => void;

  constructor(private readonly store: {set(key: 'mountSeq', value: number): unknown}) {
    this.mounted = (sequence, mountMs) => this.onMounted(sequence, mountMs);
  }

  publish(items: number): number {
    const sequence = ++this.published;
    this.sizes.set(sequence, items);
    this.store.set('mountSeq', sequence);
    return sequence;
  }

  onMounted(sequence: number, mountMs: number): void {
    if (!(sequence > this.acknowledged)) return;
    for (let s = this.acknowledged + 1; s <= sequence; s++) {
      const items = this.sizes.get(s);
      if (items != null) {
        this.sizes.delete(s);
        if (s === sequence && items > 0) this.costPerItemMs = updateMountCost(this.costPerItemMs, mountMs, items);
      }
    }
    this.acknowledged = sequence;
    const ready = this.waiters.filter((waiter) => waiter.sequence <= sequence);
    this.waiters = this.waiters.filter((waiter) => waiter.sequence > sequence);
    for (const waiter of ready) {
      if (waiter.timer != null) clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  afterMount(sequence: number, resolve: () => void): () => void {
    if (sequence <= this.acknowledged) {
      resolve();
      return () => {};
    }
    const waiter: Waiter = {sequence, resolve, timer: null};
    waiter.timer = setTimeout(() => {
      this.waiters = this.waiters.filter((value) => value !== waiter);
      resolve();
    }, MOUNT_ACK_TIMEOUT_MS);
    this.waiters.push(waiter);
    return () => {
      if (waiter.timer != null) clearTimeout(waiter.timer);
      this.waiters = this.waiters.filter((value) => value !== waiter);
    };
  }

  reset(): void {
    for (const waiter of this.waiters) if (waiter.timer != null) clearTimeout(waiter.timer);
    this.waiters = [];
    this.sizes.clear();
    this.acknowledged = this.published;
  }
}
