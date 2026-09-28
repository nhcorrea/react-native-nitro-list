export type NitroSectionBase<ItemT> = {
  data: ReadonlyArray<ItemT>;
  key?: string;
};

export type NitroSectionRow<ItemT, SectionT extends NitroSectionBase<ItemT>> =
  | {kind: 'header'; section: SectionT; sectionIndex: number; key: string}
  | {
      kind: 'item';
      item: ItemT;
      section: SectionT;
      sectionIndex: number;
      itemIndex: number;
      key: string;
    }
  | {
      kind: 'separator';
      leadingItem: ItemT;
      section: SectionT;
      sectionIndex: number;
      key: string;
    }
  | {kind: 'footer'; section: SectionT; sectionIndex: number; key: string};

export type FlattenedSections<ItemT, SectionT extends NitroSectionBase<ItemT>> = {
  rows: Array<NitroSectionRow<ItemT, SectionT>>;
  stickyHeaderIndices: number[];
  headerFlatIndex: number[];
  itemFlatIndex: number[][];
};

export function flattenSections<ItemT, SectionT extends NitroSectionBase<ItemT>>(
  sections: ReadonlyArray<SectionT>,
  options: {
    keyExtractor?: (item: ItemT, index: number) => string;
    withHeaders: boolean;
    withFooters: boolean;
    withSeparators: boolean;
  },
  previous?: FlattenedSections<ItemT, SectionT>,
): FlattenedSections<ItemT, SectionT> {
  const rows: Array<NitroSectionRow<ItemT, SectionT>> = [];
  const stickyHeaderIndices: number[] = [];
  const headerFlatIndex: number[] = [];
  const itemFlatIndex: number[][] = [];

  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const section = sections[sectionIndex];
    const sectionKey = section.key ?? String(sectionIndex);
    // Locations belong to the previous immutable snapshot. Look up candidates
    // before allocating wrappers; changes in earlier sections can shift flat indices.
    const oldStart = previous?.headerFlatIndex[sectionIndex];
    const oldItems = previous?.itemFlatIndex[sectionIndex];
    headerFlatIndex.push(rows.length);
    if (options.withHeaders) {
      stickyHeaderIndices.push(rows.length);
      const key = `s${sectionKey}:h`;
      const old = oldStart == null ? undefined : previous!.rows[oldStart];
      rows.push(
        old?.kind === 'header' && old.section === section &&
        old.sectionIndex === sectionIndex && old.key === key
          ? old
          : {kind: 'header', section, sectionIndex, key},
      );
    }
    const flatIndices: number[] = [];
    const data = section.data;
    for (let itemIndex = 0; itemIndex < data.length; itemIndex++) {
      const item = data[itemIndex];
      const itemKey = options.keyExtractor
        ? options.keyExtractor(item, itemIndex)
        : String(itemIndex);
      const key = `s${sectionKey}:i:${itemKey}`;
      const oldItemIndex = oldItems?.[itemIndex];
      const old = oldItemIndex == null ? undefined : previous!.rows[oldItemIndex];
      flatIndices.push(rows.length);
      rows.push(
        old?.kind === 'item' && old.section === section &&
        old.sectionIndex === sectionIndex && old.item === item &&
        old.itemIndex === itemIndex && old.key === key
          ? old
          : {kind: 'item', item, section, sectionIndex, itemIndex, key},
      );
      if (options.withSeparators && itemIndex < data.length - 1) {
        const separatorKey = `s${sectionKey}:sep:${itemKey}`;
        const oldSeparator = oldItemIndex == null ? undefined : previous!.rows[oldItemIndex + 1];
        rows.push(
          oldSeparator?.kind === 'separator' && oldSeparator.section === section &&
          oldSeparator.sectionIndex === sectionIndex && oldSeparator.leadingItem === item &&
          oldSeparator.key === separatorKey
            ? oldSeparator
            : {kind: 'separator', leadingItem: item, section, sectionIndex, key: separatorKey},
        );
      }
    }
    itemFlatIndex.push(flatIndices);
    if (options.withFooters) {
      const key = `s${sectionKey}:f`;
      const oldEnd = previous?.headerFlatIndex[sectionIndex + 1] ?? previous?.rows.length;
      const old = oldEnd == null ? undefined : previous!.rows[oldEnd - 1];
      rows.push(
        old?.kind === 'footer' && old.section === section &&
        old.sectionIndex === sectionIndex && old.key === key
          ? old
          : {kind: 'footer', section, sectionIndex, key},
      );
    }
  }
  return {rows, stickyHeaderIndices, headerFlatIndex, itemFlatIndex};
}

export function flatIndexForLocation<ItemT, SectionT extends NitroSectionBase<ItemT>>(
  flattened: FlattenedSections<ItemT, SectionT>,
  sectionIndex: number,
  itemIndex: number,
): number | null {
  if (sectionIndex < 0 || sectionIndex >= flattened.headerFlatIndex.length) return null;
  if (itemIndex <= 0) {
    return flattened.headerFlatIndex[sectionIndex];
  }
  const items = flattened.itemFlatIndex[sectionIndex];
  const clamped = Math.min(itemIndex - 1, items.length - 1);
  if (clamped < 0) return flattened.headerFlatIndex[sectionIndex];
  return items[clamped];
}
