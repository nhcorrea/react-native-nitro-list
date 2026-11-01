export type NitroViewWrappedCallback<T> = {f: T};

export function callback<T>(func: T): T extends (...args: never[]) => unknown ? {f: T} : T {
  return (typeof func === 'function' ? {f: func} : func) as T extends (...args: never[]) => unknown
    ? {f: T}
    : T;
}

export function getHostComponent(): never {
  throw new Error(
    'getHostComponent must not be reached in jest — NitroListHost is mapped to its mock',
  );
}

type NativeScrollCommand = (x: number, y: number, animated: boolean) => void;
const scrollViews = new Map<number, NativeScrollCommand>();

export function registerNativeScrollViewForTests(tag: number, command: NativeScrollCommand): () => void {
  scrollViews.set(tag, command);
  return () => {
    if (scrollViews.get(tag) === command) scrollViews.delete(tag);
  };
}

let eagerMountHolders = 0;
const clippedViews = new Map<number, boolean>();
const clipCalls: Array<[number, boolean]> = [];

export function nativeClipCallsForTests(): ReadonlyArray<[number, boolean]> {
  return clipCalls;
}

export function nativeClippedViewForTests(tag: number): boolean | undefined {
  return clippedViews.get(tag);
}

export function resetNativeClipForTests(): void {
  clippedViews.clear();
  clipCalls.length = 0;
}

export function nativeEagerMountHoldersForTests(): number {
  return eagerMountHolders;
}

const nativeScrollView = {
  scrollTo(tag: number, x: number, y: number, animated: boolean): void {
    setTimeout(() => scrollViews.get(tag)?.(x, y, animated), 0);
  },
  setEagerMount(enabled: boolean): void {
    eagerMountHolders += enabled ? 1 : -1;
  },
  setClipChildren(tag: number, enabled: boolean): void {
    clipCalls.push([tag, enabled]);
    clippedViews.set(tag, enabled);
  },
};

const nativeArrayBuffers = new WeakSet<ArrayBuffer>();
let nativeArrayBufferAllocations = 0;

export function isNativeArrayBufferForTests(buffer: ArrayBuffer): boolean {
  return nativeArrayBuffers.has(buffer);
}

export function nativeArrayBufferAllocationsForTests(): number {
  return nativeArrayBufferAllocations;
}

export const NitroModules = {
  createNativeArrayBuffer(size: number): ArrayBuffer {
    const buffer = new ArrayBuffer(size);
    new Uint8Array(buffer).fill(0xab);
    nativeArrayBuffers.add(buffer);
    nativeArrayBufferAllocations++;
    return buffer;
  },
  createHybridObject(name: string): unknown {
    if (name === 'NitroListScrollView') return nativeScrollView;
    throw new Error(
      'createHybridObject must not be reached in jest — NitroListHost is mapped to its mock',
    );
  },
};
