import type {HybridObject} from 'react-native-nitro-modules';

export interface NitroListNativeHost extends HybridObject<{android: 'kotlin'; ios: 'c++'}> {
  attachHost(
    engineId: number,
    scrollViewTag: number,
    stickyViewTag: number,
    horizontal: boolean,
    userHasOnScroll: boolean,
    onSlotRebinds: (
      slotCount: number,
      rangeStart: number,
      rangeEnd: number,
      layoutVersion: number,
      totalSize: number,
      stickyIndex: number,
      velocityDpS: number,
      deltas: ArrayBuffer,
    ) => void,
    onContentSize: (totalSize: number, layoutVersion: number) => void,
  ): number;

  detachHost(hostId: number): void;
  registerSlotView(hostId: number, slotId: number, viewTag: number, measures: boolean): void;
  unregisterSlotView(hostId: number, slotId: number): void;
  setSlotMeasures(hostId: number, slotId: number, measures: boolean): void;
  setStickyViewTag(hostId: number, stickyViewTag: number): void;
  setUserHasOnScroll(hostId: number, hasOnScroll: boolean): void;
  setMvcpEnabled(hostId: number, enabled: boolean): void;
  applyMvcpShift(hostId: number, deltaDp: number): void;
  notifyDataCommit(hostId: number, paddingStartDp: number, mainAxisGapDp: number): void;
  syncNow(hostId: number): void;

  // Level 2: Native Image Prefetch
  prefetchImages(uris: string[], widthPx: number, heightPx: number): void;
  cancelImagePrefetch(): void;

  // Level 3: Opt-in Zero-JS Native Declarative Cell Templates
  attachNativeSlotContainer(
    hostId: number,
    containerViewTag: number,
    numColumns: number,
    crossAxisGapDp: number,
  ): void;
  setNativeTemplateSchema(hostId: number, schemaJson: string): void;
  setNativeTemplateData(
    hostId: number,
    startIndex: number,
    count: number,
    totalCount: number,
    reset: boolean,
    packedData: ArrayBuffer,
  ): void;
  shiftNativeTemplateData(hostId: number, delta: number, totalCount: number): void;
  setNativePressHandler(
    hostId: number,
    onPress: (index: number, action: string) => void,
  ): void;
  setNativeDataRequestHandler(
    hostId: number,
    onRequestData: (startIndex: number, count: number) => void,
  ): void;
  clearNativeTemplate(hostId: number): void;
}
