import React, {useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useSyncExternalStore} from 'react';
import {StyleSheet, unstable_batchedUpdates, View, type ViewProps} from 'react-native';

type Element = React.ReactElement;
type RootProps = ViewProps & {ref?: React.Ref<View>; children?: readonly Element[]};
type RootSnapshot = {props: RootProps; keys: readonly string[]};
type Phase = 'measure' | 'layout' | 'passive';
type Listener = () => void;
type Request = {phase: Phase; callback: () => void};
const activeStores = new Set<SlotPlanStore>();
const counts = {publications: 0, notifications: 0, rootRenders: 0, slotRenders: 0, requests: 0, acknowledged: 0, cancelled: 0};
export const SlotPublicationDiagnostics = {
  enabled: false,
  reset() { for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] = 0; },
  snapshot() { return {...counts, stores: [...activeStores].map(store => store.inspect())}; },
};
function count(key: keyof typeof counts) { if (SlotPublicationDiagnostics.enabled) counts[key]++; }
function equalStyle(a: ViewProps['style'], b: ViewProps['style']) {
  if (a === b) return true;
  const x = StyleSheet.flatten(a) ?? {}, y = StyleSheet.flatten(b) ?? {};
  const keys = Object.keys(x) as Array<keyof typeof x>;
  return keys.length === Object.keys(y).length && keys.every(key => Object.is(x[key], y[key]));
}
function sameRoot(a: RootSnapshot, b: RootSnapshot) {
  if (a.keys.length !== b.keys.length || a.keys.some((key, index) => key !== b.keys[index])) return false;
  const x = a.props as Record<string, unknown>, y = b.props as Record<string, unknown>;
  const keys = Object.keys(x).filter(key => key !== 'children');
  return keys.length === Object.keys(y).filter(key => key !== 'children').length && keys.every(key =>
    key === 'style' ? equalStyle(a.props.style, b.props.style) : Object.is(x[key], y[key]));
}
function unpack(plan: React.ReactElement<RootProps>) {
  const elements = new Map<string, Element>();
  for (const element of plan.props.children ?? []) {
    if (element.key == null) throw new Error('Slot publication requires keyed cells');
    const key = String(element.key);
    if (elements.has(key)) throw new Error('Slot publication has duplicate cell keys');
    elements.set(key, element);
  }
  const {children: _children, ...props} = plan.props;
  return {elements, root: {props, keys: [...elements.keys()]} satisfies RootSnapshot};
}

/** Prototype: immutable snapshots are published after a committed planner render. */
export class SlotPlanStore {
  private root: RootSnapshot;
  private elements: Map<string, Element>;
  private token: object;
  private rootLayout: RootSnapshot | null = null;
  private rootPassive: RootSnapshot | null = null;
  private readonly layout = new Map<string, Element>();
  private readonly passive = new Map<string, Element>();
  private pendingLayout: Set<string>;
  private pendingPassive: Set<string>;
  private readonly rootListeners = new Set<Listener>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private requests: Request[] = [];
  private dead = false;

  constructor(token: object, plan: React.ReactElement<RootProps>) {
    const initial = unpack(plan); this.root = initial.root; this.elements = initial.elements; this.token = token;
    this.pendingLayout = new Set(initial.elements.keys()); this.pendingPassive = new Set(initial.elements.keys());
  }
  activate() { if (SlotPublicationDiagnostics.enabled) activeStores.add(this); }
  getRoot = () => this.root;
  getElement(key: string) { return this.elements.get(key) ?? null; }
  subscribeRoot = (listener: Listener) => { this.rootListeners.add(listener); return () => { this.rootListeners.delete(listener); }; };
  subscribe(key: string, listener: Listener) {
    let listeners = this.listeners.get(key);
    if (listeners == null) { listeners = new Set(); this.listeners.set(key, listeners); }
    listeners.add(listener);
    return () => { listeners!.delete(listener); if (listeners!.size === 0) this.listeners.delete(key); };
  }
  publish(token: object, plan: React.ReactElement<RootProps>) {
    if (this.dead) return;
    if (SlotPublicationDiagnostics.enabled) counts.cancelled += this.requests.length;
    this.requests = [];
    const next = unpack(plan), rootChanged = !sameRoot(this.root, next.root);
    const changed = new Set<string>();
    for (const [key, element] of next.elements) if (this.elements.get(key) !== element) changed.add(key);
    for (const key of this.elements.keys()) if (!next.elements.has(key)) changed.add(key);
    for (const key of this.layout.keys()) if (!next.elements.has(key)) this.layout.delete(key);
    for (const key of this.passive.keys()) if (!next.elements.has(key)) this.passive.delete(key);
    if (rootChanged) this.root = next.root;
    this.elements = next.elements; this.token = token;
    this.pendingLayout = new Set(); this.pendingPassive = new Set();
    for (const [key, element] of this.elements) {
      if (this.layout.get(key) !== element) this.pendingLayout.add(key);
      if (this.passive.get(key) !== element) this.pendingPassive.add(key);
    }
    count('publications');
    // All snapshots change before the first notification. RN0.86 exports a
    // compatibility batching shim; the layout-effect publication boundary,
    // React's sync-store checks and native oracles remain part of the proof.
    unstable_batchedUpdates(() => {
      if (rootChanged) for (const listener of this.rootListeners) { count('notifications'); listener(); }
      for (const key of changed) for (const listener of this.listeners.get(key) ?? []) { count('notifications'); listener(); }
    });
  }
  request(token: object, phase: Phase, callback: () => void) {
    count('requests');
    if (this.dead || token !== this.token) { count('cancelled'); return; }
    this.requests.push({phase, callback}); this.drain();
  }
  acknowledgeRoot(snapshot: RootSnapshot, phase: 'layout' | 'passive') {
    if (this.dead || snapshot !== this.root) return;
    if (phase === 'layout') this.rootLayout = snapshot; else this.rootPassive = snapshot;
    this.drain();
  }
  acknowledgeSlot(key: string, element: Element | null, phase: 'layout' | 'passive') {
    if (this.dead || element == null || this.elements.get(key) !== element) return;
    (phase === 'layout' ? this.layout : this.passive).set(key, element);
    (phase === 'layout' ? this.pendingLayout : this.pendingPassive).delete(key); this.drain();
  }
  private ready(phase: Phase) {
    if (this.rootLayout !== this.root || this.pendingLayout.size !== 0) return false;
    return phase !== 'passive' || (this.rootPassive === this.root && this.pendingPassive.size === 0);
  }
  private drain() {
    const current = this.token;
    const ready: Request[] = [], pending: Request[] = [];
    for (const request of this.requests) (this.ready(request.phase) ? ready : pending).push(request);
    this.requests = pending;
    for (const request of ready) {
      if (this.dead || this.token !== current) { count('cancelled'); continue; }
      count('acknowledged'); request.callback();
    }
  }
  inspect() {
    return {elements: this.elements.size, listeners: this.rootListeners.size + [...this.listeners.values()].reduce((n, set) => n + set.size, 0),
      requests: this.requests.length, layoutReady: this.ready('layout'), passiveReady: this.ready('passive'), dead: this.dead};
  }
  destroy() {
    if (SlotPublicationDiagnostics.enabled) counts.cancelled += this.requests.length;
    this.dead = true; this.requests = []; this.elements.clear(); this.layout.clear(); this.passive.clear();
    this.pendingLayout.clear(); this.pendingPassive.clear(); this.listeners.clear(); this.rootListeners.clear(); activeStores.delete(this);
    this.root = {props: {}, keys: []}; this.rootLayout = null; this.rootPassive = null;
  }
}

function slotSubscription(store: SlotPlanStore, slot: string) {
  return {subscribe: (listener: Listener) => store.subscribe(slot, listener), read: () => store.getElement(slot)};
}
function createPublisherHandle(store: SlotPlanStore): SlotPublisherHandle {
  return {request: (requested, phase, callback) => store.request(requested, phase, callback)};
}
function releaseStoreAfterUnmount(store: SlotPlanStore, lifecycle: {current: number}): () => void {
  lifecycle.current++;
  return () => {
    const cleanup = ++lifecycle.current;
    queueMicrotask(() => { if (lifecycle.current === cleanup) store.destroy(); });
  };
}

const PublishedSlot = React.memo(function PublishedSlot({store, slot}: {store: SlotPlanStore; slot: string}) {
  const {subscribe, read} = useMemo(() => slotSubscription(store, slot), [store, slot]);
  const element = useSyncExternalStore(subscribe, read, read);
  count('slotRenders');
  useLayoutEffect(() => { store.acknowledgeSlot(slot, element, 'layout'); }, [store, slot, element]);
  useEffect(() => { store.acknowledgeSlot(slot, element, 'passive'); }, [store, slot, element]);
  return element;
});
const PublishedRoot = React.memo(function PublishedRoot({store}: {store: SlotPlanStore}) {
  const snapshot = useSyncExternalStore(store.subscribeRoot, store.getRoot, store.getRoot);
  const children = useMemo(() => snapshot.keys.map(key => <PublishedSlot key={key} slot={key} store={store} />), [snapshot.keys, store]);
  count('rootRenders');
  useLayoutEffect(() => { store.acknowledgeRoot(snapshot, 'layout'); }, [store, snapshot]);
  useEffect(() => { store.acknowledgeRoot(snapshot, 'passive'); }, [store, snapshot]);
  return <View {...snapshot.props}>{children}</View>;
});
export type SlotPublisherHandle = {request: (token: object, phase: Phase, callback: () => void) => void};
export const SlotPublisher = React.forwardRef<SlotPublisherHandle, {token: object; plan: React.ReactElement<RootProps>}>(function SlotPublisher({token, plan}, ref) {
  const storeRef = useRef<SlotPlanStore | null>(null);
  if (storeRef.current == null) storeRef.current = new SlotPlanStore(token, plan);
  const store = storeRef.current;
  const lifecycle = useRef(0);
  useImperativeHandle(ref, () => createPublisherHandle(store), [store]);
  useLayoutEffect(() => { store.activate(); store.publish(token, plan); }, [store, token, plan]);
  useLayoutEffect(() => releaseStoreAfterUnmount(store, lifecycle), [store]);
  return <PublishedRoot store={store} />;
});
