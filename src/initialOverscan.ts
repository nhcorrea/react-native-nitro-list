export type InitialOverscanEvent = {stage: string; limit: number; target: number; atMs: number};
let observer: ((event: InitialOverscanEvent) => void) | undefined;
export function setInitialOverscanObserver(next?: (event: InitialOverscanEvent) => void): void { observer = next; }
export type InitialOverscanDriver = {
  target: () => number;
  current: () => boolean;
  publish: (limit: number) => void;
  afterMount: (callback: (confirmed: boolean) => void) => () => void;
  frame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  finish: (reason: string, notify: boolean) => void;
  now: () => number;
};

/** Count-limited optional content. A timeout falls back; it never confirms a mount. */
export class InitialOverscanAdmission {
  private active = true;
  private waiting = false;
  private frameId: number | null = null;
  private cancelWait: (() => void) | null = null;
  constructor(private limit: number, private readonly driver: InitialOverscanDriver) { this.emit('start'); }
  private emit(stage: string): void {
    if (observer) observer({stage, limit: this.limit, target: this.driver.target(), atMs: this.driver.now()});
  }
  validate(): void {
    if (this.active && !this.driver.current()) this.stop('superseded');
  }
  committed(): void {
    if (!this.active) return;
    if (!this.driver.current()) { this.stop('superseded'); return; }
    if (this.waiting || this.frameId != null) return;
    if (this.limit >= this.driver.target()) { this.stop('complete'); return; }
    this.waiting = true;
    this.emit('react-commit');
    const cancel = this.driver.afterMount(confirmed => {
      if (!this.active) return;
      this.waiting = false;
      this.cancelWait = null;
      if (!this.driver.current()) { this.stop('superseded'); return; }
      if (!confirmed) { this.stop('unconfirmed-mount'); return; }
      this.emit('native-ack');
      this.frameId = this.driver.frame(() => {
        this.frameId = null;
        if (!this.active) return;
        if (!this.driver.current()) { this.stop('superseded'); return; }
        if (this.limit >= this.driver.target()) { this.stop('complete'); return; }
        this.limit++;
        this.emit('admit');
        this.driver.publish(this.limit);
      });
    });
    if (this.waiting) this.cancelWait = cancel;
    else cancel(); // Handles an already acknowledged marker without retaining its waiter.
  }
  stop(reason: string, notify = true): void {
    if (!this.active) return;
    this.active = false;
    if (this.frameId != null) this.driver.cancelFrame(this.frameId);
    this.frameId = null;
    this.cancelWait?.();
    this.cancelWait = null;
    this.waiting = false;
    this.emit(reason);
    this.driver.finish(reason, notify);
  }
}
