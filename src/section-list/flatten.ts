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
): FlattenedSections<ItemT, SectionT> {
  const rows: Array<NitroSectionRow<ItemT, SectionT>> = [];
  const stickyHeaderIndices: number[] = [];
  const headerFlatIndex: number[] = [];
  const itemFlatIndex: number[][] = [];

  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const section = sections[sectionIndex];
    const sectionKey = section.key ?? String(sectionIndex);
    headerFlatIndex.push(rows.length);
    if (options.withHeaders) {
      stickyHeaderIndices.push(rows.length);
      rows.push({kind: 'header', section, sectionIndex, key: `s${sectionKey}:h`});
    }
    const flatIndices: number[] = [];
    const data = section.data;
    for (let itemIndex = 0; itemIndex < data.length; itemIndex++) {
      const item = data[itemIndex];
      const itemKey = options.keyExtractor
        ? options.keyExtractor(item, itemIndex)
        : String(itemIndex);
      flatIndices.push(rows.length);
      rows.push({
        kind: 'item',
        item,
        section,
        sectionIndex,
        itemIndex,
        key: `s${sectionKey}:i:${itemKey}`,
      });
      if (options.withSeparators && itemIndex < data.length - 1) {
        rows.push({
          kind: 'separator',
          leadingItem: item,
          section,
          sectionIndex,
          key: `s${sectionKey}:sep:${itemKey}`,
        });
      }
    }
    itemFlatIndex.push(flatIndices);
    if (options.withFooters) {
      rows.push({kind: 'footer', section, sectionIndex, key: `s${sectionKey}:f`});
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
