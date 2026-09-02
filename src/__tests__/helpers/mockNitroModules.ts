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

export const NitroModules = {
  createHybridObject(): never {
    throw new Error(
      'createHybridObject must not be reached in jest — NitroListHost is mapped to its mock',
    );
  },
};
