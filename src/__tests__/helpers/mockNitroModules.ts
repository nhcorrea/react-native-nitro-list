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

const throttleCalls: Array<[number, number]> = [];

export function nativeScrollThrottleCallsForTests(): ReadonlyArray<[number, number]> {
  return throttleCalls;
}

export function resetNativeScrollThrottleForTests(): void {
  throttleCalls.length = 0;
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
  setScrollEventThrottle(tag: number, throttleMs: number): void {
    throttleCalls.push([tag, throttleMs]);
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

export interface MockNativeHostSession {
  hostId: number;
  engineId: number;
  scrollViewTag: number;
  stickyViewTag: number;
  horizontal: boolean;
  userHasOnScroll: boolean;
  mvcpEnabled: boolean;
  paddingStartDp: number;
  mainAxisGapDp: number;
  registeredSlots: Map<number, {viewTag: number; measures: boolean}>;
  onSlotRebinds: (
    slotCount: number,
    rangeStart: number,
    rangeEnd: number,
    layoutVersion: number,
    totalSize: number,
    stickyIndex: number,
    velocityDpS: number,
    deltas: ArrayBuffer,
  ) => void;
  onContentSize: (totalSize: number, layoutVersion: number) => void;
  detached: boolean;
  templateContainerTag: number;
  templateNumColumns: number;
  templateCrossAxisGapDp: number;
  templateSchemaJson: string | null;
  templateChunks: Array<{
    startIndex: number;
    count: number;
    totalCount: number;
    reset: boolean;
    byteLength: number;
  }>;
  onNativePress: ((index: number, action: string) => void) | null;
  onNativeDataRequest: ((startIndex: number, count: number) => void) | null;
  templateShifts: Array<{delta: number; totalCount: number}>;
  templateClearCount: number;
}

let mockNativeHostEnabled = false;
let nextMockHostId = 1;
const mockHostSessions = new Map<number, MockNativeHostSession>();
const prefetchCalls: Array<{uris: string[]; widthPx: number; heightPx: number}> = [];
let cancelPrefetchCount = 0;

export function setNativeHostMockEnabledForTests(enabled: boolean): void {
  mockNativeHostEnabled = enabled;
}

export function getMockNativeHostSessionsForTests(): ReadonlyMap<number, MockNativeHostSession> {
  return mockHostSessions;
}

export function getMockPrefetchCallsForTests(): ReadonlyArray<{
  uris: string[];
  widthPx: number;
  heightPx: number;
}> {
  return prefetchCalls;
}

export function getMockCancelPrefetchCountForTests(): number {
  return cancelPrefetchCount;
}

export function resetMockNativeHostForTests(): void {
  mockNativeHostEnabled = false;
  mockHostSessions.clear();
  prefetchCalls.length = 0;
  cancelPrefetchCount = 0;
}

const nativeHostMock = {
  attachHost(
    engineId: number,
    scrollViewTag: number,
    stickyViewTag: number,
    horizontal: boolean,
    userHasOnScroll: boolean,
    onSlotRebinds: MockNativeHostSession['onSlotRebinds'],
    onContentSize: MockNativeHostSession['onContentSize'],
  ): number {
    const hostId = nextMockHostId++;
    mockHostSessions.set(hostId, {
      hostId,
      engineId,
      scrollViewTag,
      stickyViewTag,
      horizontal,
      userHasOnScroll,
      mvcpEnabled: false,
      paddingStartDp: 0,
      mainAxisGapDp: 0,
      registeredSlots: new Map(),
      onSlotRebinds,
      onContentSize,
      detached: false,
      templateContainerTag: -1,
      templateNumColumns: 1,
      templateCrossAxisGapDp: 0,
      templateSchemaJson: null,
      templateChunks: [],
      onNativePress: null,
      onNativeDataRequest: null,
      templateShifts: [],
      templateClearCount: 0,
    });
    return hostId;
  },
  detachHost(hostId: number): void {
    const s = mockHostSessions.get(hostId);
    if (s != null) s.detached = true;
  },
  registerSlotView(hostId: number, slotId: number, viewTag: number, measures: boolean): void {
    mockHostSessions.get(hostId)?.registeredSlots.set(slotId, {viewTag, measures});
  },
  unregisterSlotView(hostId: number, slotId: number): void {
    mockHostSessions.get(hostId)?.registeredSlots.delete(slotId);
  },
  setSlotMeasures(hostId: number, slotId: number, measures: boolean): void {
    const entry = mockHostSessions.get(hostId)?.registeredSlots.get(slotId);
    if (entry != null) entry.measures = measures;
  },
  setStickyViewTag(hostId: number, stickyViewTag: number): void {
    const s = mockHostSessions.get(hostId);
    if (s != null) s.stickyViewTag = stickyViewTag;
  },
  setUserHasOnScroll(hostId: number, hasOnScroll: boolean): void {
    const s = mockHostSessions.get(hostId);
    if (s != null) s.userHasOnScroll = hasOnScroll;
  },
  setMvcpEnabled(hostId: number, enabled: boolean): void {
    const s = mockHostSessions.get(hostId);
    if (s != null) s.mvcpEnabled = enabled;
  },
  applyMvcpShift(_hostId: number, _deltaDp: number): void {},
  notifyDataCommit(hostId: number, paddingStartDp: number, mainAxisGapDp: number): void {
    const s = mockHostSessions.get(hostId);
    if (s != null) {
      s.paddingStartDp = paddingStartDp;
      s.mainAxisGapDp = mainAxisGapDp;
    }
  },
  syncNow(_hostId: number): void {},
  prefetchImages(uris: string[], widthPx: number, heightPx: number): void {
    prefetchCalls.push({uris: [...uris], widthPx, heightPx});
  },
  cancelImagePrefetch(): void {
    cancelPrefetchCount++;
  },
  attachNativeSlotContainer(
    hostId: number,
    containerViewTag: number,
    numColumns: number,
    crossAxisGapDp: number,
  ): void {
    const s = mockHostSessions.get(hostId);
    if (s != null) {
      s.templateContainerTag = containerViewTag;
      s.templateNumColumns = numColumns;
      s.templateCrossAxisGapDp = crossAxisGapDp;
    }
  },
  setNativeTemplateSchema(hostId: number, schemaJson: string): void {
    const s = mockHostSessions.get(hostId);
    if (s != null) s.templateSchemaJson = schemaJson;
  },
  setNativeTemplateData(
    hostId: number,
    startIndex: number,
    count: number,
    totalCount: number,
    reset: boolean,
    packedData: ArrayBuffer,
  ): void {
    const s = mockHostSessions.get(hostId);
    if (s != null) {
      s.templateChunks.push({
        startIndex,
        count,
        totalCount,
        reset,
        byteLength: packedData.byteLength,
      });
    }
  },
  shiftNativeTemplateData(hostId: number, delta: number, totalCount: number): void {
    const s = mockHostSessions.get(hostId);
    if (s != null) {
      s.templateShifts.push({delta, totalCount});
    }
  },
  setNativePressHandler(hostId: number, onPress: (index: number, action: string) => void): void {
    const s = mockHostSessions.get(hostId);
    if (s != null) s.onNativePress = onPress;
  },
  setNativeDataRequestHandler(
    hostId: number,
    onRequestData: (startIndex: number, count: number) => void,
  ): void {
    const s = mockHostSessions.get(hostId);
    if (s != null) s.onNativeDataRequest = onRequestData;
  },
  clearNativeTemplate(hostId: number): void {
    const s = mockHostSessions.get(hostId);
    if (s != null) {
      s.templateSchemaJson = null;
      s.templateChunks = [];
      s.templateClearCount++;
    }
  },
};

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
    if (name === 'NitroListNativeHost') {
      if (!mockNativeHostEnabled) {
        throw new Error('NitroListNativeHost mock disabled by default in jest');
      }
      return nativeHostMock;
    }
    throw new Error(
      'createHybridObject must not be reached in jest — NitroListHost is mapped to its mock',
    );
  },
};
