import type {HybridView, HybridViewMethods, HybridViewProps} from 'react-native-nitro-modules';

export interface NitroListViewProps extends HybridViewProps {
  itemCount: number;
  estimatedItemSize: number;
  drawDistance: number;
  horizontal: boolean;
  numColumns: number;
  onRangeChange?: (start: number, end: number, layoutVersion: number, offset: number) => void;
}

export interface NitroListViewMethods extends HybridViewMethods {
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
  setItemTypes(types: ArrayBuffer): void;
  setItemSpans(spans: ArrayBuffer): void;
  seedTypeMeans(pairs: ArrayBuffer): void;
  fillLayoutSlab(slab: ArrayBuffer): number;
  fillTypeStats(out: ArrayBuffer): number;
  getItemOffset(index: number): number;
  getItemSize(index: number): number;
  getTotalSize(): number;
}

export type NitroListView = HybridView<NitroListViewProps, NitroListViewMethods>;
