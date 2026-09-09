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

const nativeScrollView = {
  scrollTo(tag: number, x: number, y: number, animated: boolean): void {
    // Model a single UI queue, resolving the view when the command executes.
    setTimeout(() => scrollViews.get(tag)?.(x, y, animated), 0);
  },
};

export const NitroModules = {
  createHybridObject(name: string): unknown {
    if (name === 'NitroListScrollView') return nativeScrollView;
    throw new Error(
      'createHybridObject must not be reached in jest — NitroListHost is mapped to its mock',
    );
  },
};
