import {useCallback, useSyncExternalStore} from 'react';

export type RangeState = {start: number; end: number; layoutVersion: number};

export interface ListStoreState {
  range: RangeState;
  prewarmRange: RangeState | null;
  stickyIndex: number;
  totalSize: number;
  autoFixedTypes: ReadonlyMap<string | number, number> | null;
  renderMode: 'normal' | 'fast';
  endSpace: number;
  mvcpAdjust: number;
}

export type ListStoreKey = keyof ListStoreState;

type Listener = () => void;

export class ListStore {
  private readonly state: ListStoreState;
  private readonly listeners = new Map<ListStoreKey, Set<Listener>>();

  constructor(initial: ListStoreState) {
    this.state = {...initial};
  }

  get<K extends ListStoreKey>(key: K): ListStoreState[K] {
    return this.state[key];
  }

  set<K extends ListStoreKey>(key: K, value: ListStoreState[K]): boolean {
    if (Object.is(this.state[key], value)) return false;
    this.state[key] = value;
    const set = this.listeners.get(key);
    if (set != null && set.size > 0) {
      for (const listener of Array.from(set)) listener();
    }
    return true;
  }

  subscribe(key: ListStoreKey, listener: Listener): () => void {
    let set = this.listeners.get(key);
    if (set == null) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }
}

export function useStoreValue<K extends ListStoreKey>(store: ListStore, key: K): ListStoreState[K] {
  const subscribe = useCallback(
    (listener: Listener) => store.subscribe(key, listener),
    [store, key],
  );
  const read = useCallback(() => store.get(key), [store, key]);
  return useSyncExternalStore(subscribe, read, read);
}
