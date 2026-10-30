import type {NitroListPrepareItem} from './types';

export type PreparationStage = 'queued' | 'started' | 'prepared' | 'cancelled' | 'failed' | 'released';
export interface PreparationEvent {
  queueId: number;
  id: number;
  key: string;
  index: number;
  stage: PreparationStage;
  atMs: number;
  ageMs: number;
}
let nextQueueId = 0;
let diagnosticObserver: ((event: PreparationEvent) => void) | undefined;
type QueueCounts = {retained: number; waiting: number; inFlight: number; prepared: number};
const aggregateCounts: QueueCounts = {retained: 0, waiting: 0, inFlight: 0, prepared: 0};

/** Numeric counters only; this never retains queues, tasks, items or resources. */
export function getPreparationQueueCounts(): QueueCounts {
  return {...aggregateCounts};
}

/** Research instrumentation; unset during performance collection. */
export function setPreparationObserver(observer?: (event: PreparationEvent) => void): void {
  diagnosticObserver = observer;
}
type Task<T> = {
  id: number;
  key: string;
  index: number;
  item: T;
  controller: AbortController;
  prepare: NitroListPrepareItem<T>;
  stage: PreparationStage;
  queuedAtMs: number;
};

/** Optional work only: visible content never waits on this queue. */
export class ResourcePreparationQueue<T> {
  private readonly queueId = ++nextQueueId;
  private readonly tasks = new Map<string, Task<T>>();
  private readonly waiting: Task<T>[] = [];
  private inFlight = 0;
  private nextId = 0;
  private pumping = false;
  private publishedCounts: QueueCounts = {retained: 0, waiting: 0, inFlight: 0, prepared: 0};

  private publishCounts(): void {
    const next = this.inspect();
    for (const key of ['retained', 'waiting', 'inFlight', 'prepared'] as const) {
      aggregateCounts[key] += next[key] - this.publishedCounts[key];
    }
    this.publishedCounts = next;
  }

  constructor(
    private readonly concurrency = 2,
    private readonly capacity = 32,
    private readonly observe: ((event: PreparationEvent) => void) | undefined = diagnosticObserver,
    private readonly clock: () => number = Date.now,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(capacity) || capacity < concurrency) {
      throw new Error('Invalid resource preparation capacity');
    }
  }

  private note(task: Task<T>, stage: PreparationStage): void {
    task.stage = stage;
    if (this.observe == null) return;
    const atMs = this.clock();
    this.observe({queueId: this.queueId, id: task.id, key: task.key, index: task.index, stage, atMs, ageMs: atMs - task.queuedAtMs});
  }

  propose(
    entries: ReadonlyArray<{item: T; index: number; key: string}>,
    prepare: NitroListPrepareItem<T>,
  ): void {
    const selected = entries.slice(0, this.capacity);
    const desired = new Map(selected.map(entry => [entry.key, entry]));
    for (const [key, task] of this.tasks) {
      const next = desired.get(key);
      if (next != null && next.item === task.item && next.index === task.index && task.prepare === prepare) continue;
      this.tasks.delete(key);
      this.note(task, task.stage === 'prepared' ? 'released' : 'cancelled');
      task.controller.abort();
    }
    // Remove cancelled entries before admitting replacements. Running callbacks
    // retain their capacity until they settle, even when their signal is aborted.
    for (let index = this.waiting.length - 1; index >= 0; --index) {
      const task = this.waiting[index];
      if (this.tasks.get(task.key) !== task) this.waiting.splice(index, 1);
    }
    for (const entry of selected) {
      if (this.tasks.has(entry.key)) continue;
      const task: Task<T> = {
        ...entry, id: ++this.nextId, prepare, controller: new AbortController(),
        stage: 'queued', queuedAtMs: this.observe == null ? 0 : this.clock(),
      };
      this.tasks.set(task.key, task);
      this.waiting.push(task);
      this.note(task, 'queued');
    }
    this.pump();
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.inFlight < this.concurrency && this.waiting.length > 0) {
        const task = this.waiting.shift()!;
        if (this.tasks.get(task.key) !== task || task.controller.signal.aborted) continue;
        ++this.inFlight;
        this.note(task, 'started');
        let result: void | Promise<void>;
        try {
          result = task.prepare({item: task.item, index: task.index, key: task.key, signal: task.controller.signal});
        } catch {
          this.fail(task);
          continue;
        }
        Promise.resolve(result).then(
          () => {
            if (this.tasks.get(task.key) === task && !task.controller.signal.aborted) this.note(task, 'prepared');
            this.publishCounts();
          },
          () => {
            if (this.tasks.get(task.key) === task && !task.controller.signal.aborted) {
              this.note(task, 'failed');
              task.controller.abort();
            }
            this.publishCounts();
          },
        ).finally(() => {
          --this.inFlight;
          this.pump();
        });
      }
    } finally {
      this.pumping = false;
      this.publishCounts();
    }
  }

  private fail(task: Task<T>): void {
    this.note(task, 'failed');
    task.controller.abort();
    --this.inFlight;
  }

  clear(): void {
    this.propose([], () => {});
  }

  inspect(): {retained: number; waiting: number; inFlight: number; prepared: number} {
    let prepared = 0;
    for (const task of this.tasks.values()) if (task.stage === 'prepared') ++prepared;
    return {retained: this.tasks.size, waiting: this.waiting.length, inFlight: this.inFlight, prepared};
  }
}
