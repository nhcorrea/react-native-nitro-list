import React, {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useInsertionEffect,
} from 'react';

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
  renderItem: (info: {item: ItemT; index: number; section: SectionT}) => React.ReactElement | null;
  renderSectionHeader?: (info: {section: SectionT}) => React.ReactElement | null;
  renderSectionFooter?: (info: {section: SectionT}) => React.ReactElement | null;
  ItemSeparatorComponent?: React.ComponentType<{leadingItem: ItemT}> | null;
  keyExtractor?: (item: ItemT, index: number) => string;
  getItemType?: (item: ItemT, index: number) => string | number;
  stickySectionHeadersEnabled?: boolean;
  onViewableItemsChanged?: NitroSectionListOnViewableItemsChanged<ItemT, SectionT>;
};

function rowKeyExtractor(row: {key: string}): string {
  return row.key;
}

function createRowType<ItemT, SectionT extends NitroSectionBase<ItemT>>(
  getItemType: ((item: ItemT, index: number) => string | number) | undefined,
): (row: NitroSectionRow<ItemT, SectionT>) => string {
  return (row) => {
    if (row.kind === 'item' && getItemType != null) {
      return `item:${getItemType(row.item, row.itemIndex)}`;
    }
    return row.kind;
  };
}

function createRenderRow<ItemT, SectionT extends NitroSectionBase<ItemT>>(
  renderItem: NitroSectionListProps<ItemT, SectionT>['renderItem'],
  renderSectionHeader: NitroSectionListProps<ItemT, SectionT>['renderSectionHeader'],
  renderSectionFooter: NitroSectionListProps<ItemT, SectionT>['renderSectionFooter'],
  ItemSeparatorComponent: NitroSectionListProps<ItemT, SectionT>['ItemSeparatorComponent'],
): NitroListRenderItem<NitroSectionRow<ItemT, SectionT>> {
  return ({item: row}) => {
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
  };
}

function translateViewTokens<ItemT, SectionT extends NitroSectionBase<ItemT>>(
  tokens: ReadonlyArray<NitroListViewToken<NitroSectionRow<ItemT, SectionT>>>,
): Array<NitroSectionListViewToken<ItemT, SectionT>> {
  const translated: Array<NitroSectionListViewToken<ItemT, SectionT>> = [];
  for (const token of tokens) {
    const row = token.item;
    if (row.kind !== 'item') continue;
    translated.push({
      item: row.item,
      key: token.key,
      index: row.itemIndex,
      section: row.section,
      sectionIndex: row.sectionIndex,
      isViewable: token.isViewable,
      timestamp: token.timestamp,
    });
  }
  return translated;
}

function createViewableRowsHandler<ItemT, SectionT extends NitroSectionBase<ItemT>>(
  onViewableItemsChanged: NitroSectionListOnViewableItemsChanged<ItemT, SectionT> | undefined,
): NitroListOnViewableItemsChanged<NitroSectionRow<ItemT, SectionT>> | undefined {
  if (onViewableItemsChanged == null) return undefined;
  return ({viewableItems, changed}) => {
    const translatedViewable = translateViewTokens(viewableItems);
    const translatedChanged = translateViewTokens(changed);
    if (translatedViewable.length === 0 && translatedChanged.length === 0) return;
    onViewableItemsChanged({
      viewableItems: translatedViewable,
      changed: translatedChanged,
    });
  };
}

function createSectionListHandle<ItemT, SectionT extends NitroSectionBase<ItemT>>(
  listRef: {current: NitroListHandle | null},
  flattenedRef: {current: FlattenedSections<ItemT, SectionT> | undefined},
): NitroSectionListHandle {
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
      const flatIndex = flatIndexForLocation(flattenedRef.current!, sectionIndex, itemIndex);
      if (flatIndex == null || listRef.current == null) return Promise.resolve();
      return listRef.current.scrollToIndex({
        index: flatIndex,
        animated,
        viewOffset,
        viewPosition,
      });
    },
  };
}

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

  const flattenedRef = useRef<FlattenedSections<ItemT, SectionT> | undefined>(undefined);
  const withHeaders = renderSectionHeader != null;
  const withFooters = renderSectionFooter != null;
  const withSeparators = ItemSeparatorComponent != null;
  const hasKeyExtractor = keyExtractor != null;
  const flattened = useMemo<FlattenedSections<ItemT, SectionT>>(
    () =>
      flattenSections<ItemT, SectionT>(
        sections,
        {keyExtractor, withHeaders, withFooters, withSeparators},
        flattenedRef.current,
      ),
    [sections, hasKeyExtractor, withHeaders, withFooters, withSeparators, listProps.dataVersion],
  );
  useInsertionEffect(() => {
    flattenedRef.current = flattened;
  });

  const rowType = useMemo(() => createRowType<ItemT, SectionT>(getItemType), [getItemType]);

  const renderRow = useMemo(
    () => createRenderRow<ItemT, SectionT>(renderItem, renderSectionHeader, renderSectionFooter, ItemSeparatorComponent),
    [renderItem, renderSectionHeader, renderSectionFooter, ItemSeparatorComponent],
  );

  const onViewableRowsChanged = useMemo(
    () => createViewableRowsHandler<ItemT, SectionT>(onViewableItemsChanged),
    [onViewableItemsChanged],
  );

  useImperativeHandle(ref, () => createSectionListHandle(listRef, flattenedRef), []);

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
