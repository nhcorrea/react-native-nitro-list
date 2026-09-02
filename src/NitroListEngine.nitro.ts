import type {HybridObject} from 'react-native-nitro-modules';

export interface NitroListEngine extends HybridObject<{ios: 'c++'; android: 'c++'}> {
  onRangeChange?: (start: number, end: number, layoutVersion: number, offset: number) => void;

  configure(
    itemCount: number,
    estimatedItemSize: number,
    drawDistance: number,
    horizontal: boolean,
    numColumns: number,
    measurementEpsilon: number,
  ): void;

  setScrollOffset(offset: number): void;
  setScrollOffsetAndFill(offset: number, slab: ArrayBuffer): number;
  resetScrollVelocity(): void;
  setEstimatesFrozen(frozen: boolean): void;
  setViewport(width: number, height: number): void;
  setItemSize(index: number, size: number): void;
  setItemSizesBatch(pairs: ArrayBuffer, emitRange: boolean): void;
  setItemSizesBatchAnchored(pairs: ArrayBuffer, anchorIndex: number, emitRange: boolean): number;
  resetItemSizes(): void;
  remapItemSizes(pairs: ArrayBuffer): void;
  setItemTypes(types: ArrayBuffer): boolean;
  setItemTypesRange(start: number, types: ArrayBuffer): boolean;
  setItemSpans(spans: ArrayBuffer): void;
  seedTypeMeans(pairs: ArrayBuffer): void;
  fillLayoutSlab(slab: ArrayBuffer): number;
  fillTypeStats(out: ArrayBuffer): number;
  countUnmeasured(from: number, to: number): number;
  getItemOffset(index: number): number;
  getItemSize(index: number): number;
  getTotalSize(): number;
}
