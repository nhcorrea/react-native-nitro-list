import React, {forwardRef, useCallback, useImperativeHandle, useMemo, useRef} from 'react';

import {NitroList} from '../NitroList';
import type {
  NitroListHandle,
  NitroListProps,
  NitroListRenderItem,
  NitroListOnViewableItemsChanged,
  NitroListViewToken,
} from '../NitroList';
import {
  flatIndexForLocation,
  flattenSections,
  type FlattenedSections,
  type NitroSectionBase,
  type NitroSectionRow,
} from './flatten';

export type NitroSectionListScrollToLocationParams = {
  sectionIndex: number;
  itemIndex: number;
  animated?: boolean;
  viewOffset?: number;
  viewPosition?: number;
};

export type NitroSectionListHandle = NitroListHandle & {
  scrollToLocation: (params: NitroSectionListScrollToLocationParams) => Promise<void>;
};

export type NitroSectionListViewToken<ItemT, SectionT> = {
  item: ItemT;
  key: string;
  index: number;
  section: SectionT;
  sectionIndex: number;
  isViewable: boolean;
  timestamp: number;
};

export type NitroSectionListOnViewableItemsChanged<ItemT, SectionT> = (info: {
  viewableItems: Array<NitroSectionListViewToken<ItemT, SectionT>>;
  changed: Array<NitroSectionListViewToken<ItemT, SectionT>>;
}) => void;

type OmittedListProps =
  | 'data'
  | 'renderItem'
  | 'keyExtractor'
  | 'getItemType'
  | 'stickyHeaderIndices'
  | 'numColumns'
  | 'overrideItemLayout'
  | 'columnWrapperStyle'
  | 'onViewableItemsChanged'
  | 'ItemSeparatorComponent';

export type NitroSectionListProps<
  ItemT,
  SectionT extends NitroSectionBase<ItemT> = NitroSectionBase<ItemT>,
> = Omit<NitroListProps<NitroSectionRow<ItemT, SectionT>>, OmittedListProps> & {
  sections: ReadonlyArray<SectionT>;
  renderItem: (info: {
    item: ItemT;
    index: number;
    section: SectionT;
  }) => React.ReactElement | null;
  renderSectionHeader?: (info: {section: SectionT}) => React.ReactElement | null;
  renderSectionFooter?: (info: {section: SectionT}) => React.ReactElement | null;
  ItemSeparatorComponent?: React.ComponentType<{leadingItem: ItemT}> | null;
  keyExtractor?: (item: ItemT, index: number) => string;
  getItemType?: (item: ItemT, index: number) => string | number;
  stickySectionHeadersEnabled?: boolean;
  onViewableItemsChanged?: NitroSectionListOnViewableItemsChanged<ItemT, SectionT>;
};

function NitroSectionListInner<
  ItemT,
  SectionT extends NitroSectionBase<ItemT> = NitroSectionBase<ItemT>,
>(props: NitroSectionListProps<ItemT, SectionT>, ref: React.Ref<NitroSectionListHandle>) {
  const {
    sections,
    renderItem,
    renderSectionHeader,
    renderSectionFooter,
    ItemSeparatorComponent,
    keyExtractor,
    getItemType,
    stickySectionHeadersEnabled = true,
    onViewableItemsChanged,
    viewabilityConfig,
    ...listProps
  } = props;

  const listRef = useRef<NitroListHandle | null>(null);

  const flattened = useMemo<FlattenedSections<ItemT, SectionT>>(
    () =>
      flattenSections<ItemT, SectionT>(sections, {
        keyExtractor,
        withHeaders: renderSectionHeader != null,
        withFooters: renderSectionFooter != null,
        withSeparators: ItemSeparatorComponent != null,
      }),
    [sections, keyExtractor, renderSectionHeader, renderSectionFooter, ItemSeparatorComponent],
  );
  const flattenedRef = useRef(flattened);
  flattenedRef.current = flattened;

  const rowKeyExtractor = useCallback(
    (row: NitroSectionRow<ItemT, SectionT>) => row.key,
    [],
  );

  const rowType = useCallback(
    (row: NitroSectionRow<ItemT, SectionT>) => {
      if (row.kind === 'item' && getItemType != null) {
        return `item:${getItemType(row.item, row.itemIndex)}`;
      }
      return row.kind;
    },
    [getItemType],
  );

  const renderRow = useCallback<NitroListRenderItem<NitroSectionRow<ItemT, SectionT>>>(
    ({item: row}) => {
      switch (row.kind) {
        case 'header':
          return renderSectionHeader?.({section: row.section}) ?? null;
        case 'footer':
          return renderSectionFooter?.({section: row.section}) ?? null;
        case 'separator':
          return ItemSeparatorComponent != null ? (
            <ItemSeparatorComponent leadingItem={row.leadingItem} />
          ) : null;
        case 'item':
          return renderItem({item: row.item, index: row.itemIndex, section: row.section});
      }
    },
    [renderItem, renderSectionHeader, renderSectionFooter, ItemSeparatorComponent],
  );

  const onViewableRowsChanged = useMemo<
    NitroListOnViewableItemsChanged<NitroSectionRow<ItemT, SectionT>> | undefined
  >(() => {
    if (onViewableItemsChanged == null) return undefined;
    const translate = (
      token: NitroListViewToken<NitroSectionRow<ItemT, SectionT>>,
    ): NitroSectionListViewToken<ItemT, SectionT> | null => {
      const row = token.item;
      if (row.kind !== 'item') return null;
      return {
        item: row.item,
        key: token.key,
        index: row.itemIndex,
        section: row.section,
        sectionIndex: row.sectionIndex,
        isViewable: token.isViewable,
        timestamp: token.timestamp,
      };
    };
    return ({viewableItems, changed}) => {
      const translatedViewable = viewableItems
        .map(translate)
        .filter((token): token is NitroSectionListViewToken<ItemT, SectionT> => token != null);
      const translatedChanged = changed
        .map(translate)
        .filter((token): token is NitroSectionListViewToken<ItemT, SectionT> => token != null);
      if (translatedViewable.length === 0 && translatedChanged.length === 0) return;
      onViewableItemsChanged({
        viewableItems: translatedViewable,
        changed: translatedChanged,
      });
    };
  }, [onViewableItemsChanged]);

  useImperativeHandle(
    ref,
    () => {
      const base = (): NitroListHandle => {
        const current = listRef.current;
        if (current == null) throw new Error('NitroSectionList handle is not attached');
        return current;
      };
      return {
        scrollToOffset: (params) => base().scrollToOffset(params),
        scrollToIndex: (params) => base().scrollToIndex(params),
        scrollToEnd: (animated) => base().scrollToEnd(animated),
        getAbsoluteLastScrollOffset: () => base().getAbsoluteLastScrollOffset(),
        getItemOffset: (index) => base().getItemOffset(index),
        getItemSize: (index) => base().getItemSize(index),
        getTotalSize: () => base().getTotalSize(),
        getLayout: (index) => base().getLayout(index),
        getWindowSize: () => base().getWindowSize(),
        getFirstItemOffset: () => base().getFirstItemOffset(),
        getScrollableNode: () => base().getScrollableNode(),
        getNativeScrollRef: () => base().getNativeScrollRef(),
        getAverageItemSizes: () => base().getAverageItemSizes(),
        reportContentInset: (insets) => base().reportContentInset(insets),
        scrollIndexIntoView: (params) => base().scrollIndexIntoView(params),
        scrollItemIntoView: (params) => base().scrollItemIntoView(params),
        scrollToLocation({
          sectionIndex,
          itemIndex,
          animated = false,
          viewOffset = 0,
          viewPosition = 0,
        }: NitroSectionListScrollToLocationParams) {
          const flatIndex = flatIndexForLocation(flattenedRef.current, sectionIndex, itemIndex);
          if (flatIndex == null || listRef.current == null) return Promise.resolve();
          return listRef.current.scrollToIndex({
            index: flatIndex,
            animated,
            viewOffset,
            viewPosition,
          });
        },
      };
    },
    [],
  );

  return (
    <NitroList<NitroSectionRow<ItemT, SectionT>>
      {...listProps}
      ref={listRef}
      data={flattened.rows}
      renderItem={renderRow}
      keyExtractor={rowKeyExtractor}
      getItemType={rowType}
      stickyHeaderIndices={
        stickySectionHeadersEnabled && renderSectionHeader != null
          ? flattened.stickyHeaderIndices
          : undefined
      }
      viewabilityConfig={viewabilityConfig}
      onViewableItemsChanged={onViewableRowsChanged}
    />
  );
}

export const NitroSectionList = forwardRef(NitroSectionListInner) as <
  ItemT,
  SectionT extends NitroSectionBase<ItemT> = NitroSectionBase<ItemT>,
>(
  props: NitroSectionListProps<ItemT, SectionT> & {ref?: React.Ref<NitroSectionListHandle>},
) => React.ReactElement | null;
