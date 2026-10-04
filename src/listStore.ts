import {useCallback, useRef, useSyncExternalStore} from 'react';

export type RangeState = {start: number; end: number; layoutVersion: number};

export interface ListStoreState {
  range: RangeState;
  prewarmRange: RangeState | null;
  stickyIndex: number;
  containerSize: number;
  autoFixedTypes: ReadonlyMap<string | number, number> | null;
  renderMode: 'normal' | 'fast';
  endSpace: number;
  mvcpAdjust: number;
  dataItems: ReadonlyArray<unknown> | null;
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

type StoreSelection<K extends ListStoreKey> = {
  store: ListStore;
  keys: readonly K[];
  subscribe: (listener: Listener) => () => void;
  read: () => Pick<ListStoreState, K>;
};

function createStoreSelection<K extends ListStoreKey>(
  store: ListStore,
  keys: readonly K[],
): StoreSelection<K> {
  let cached: Pick<ListStoreState, K> | null = null;
  return {
    store,
    keys,
    subscribe(listener) {
      const unsubscribes = keys.map((key) => store.subscribe(key, listener));
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    read() {
      if (cached != null) {
        let same = true;
        for (const key of keys) {
          if (!Object.is(cached[key], store.get(key))) {
            same = false;
            break;
          }
        }
        if (same) return cached;
      }
      const next = {} as Pick<ListStoreState, K>;
      for (const key of keys) next[key] = store.get(key);
      cached = next;
      return next;
    },
  };
}

export function useStoreValues<K extends ListStoreKey>(
  store: ListStore,
  keys: readonly K[],
): Pick<ListStoreState, K> {
  const selectionRef = useRef<StoreSelection<K> | null>(null);
  let selection = selectionRef.current;
  if (selection == null || selection.store !== store || selection.keys !== keys) {
    selection = createStoreSelection(store, keys);
    selectionRef.current = selection;
  }
  return useSyncExternalStore(selection.subscribe, selection.read, selection.read);
}
