import {describe, expect, it} from '@jest/globals';

import type {NitroListPrepareItem, NitroListProps} from '../index';
import type {NitroSectionListProps} from '../section-list';

describe('public API', () => {
  it('exposes prepareItem and the type of its callback', () => {
    const exposed: 'prepareItem' extends keyof NitroListProps<unknown> ? true : false = true;
    const prepare: NitroListPrepareItem<{uri: string}> = ({item, index, key, signal}) => {
      if (signal.aborted || index < 0 || key.length === 0) return undefined;
      return Promise.resolve(item.uri).then(() => undefined);
    };
    const props: Pick<NitroListProps<{uri: string}>, 'prepareItem'> = {prepareItem: prepare};

    expect(exposed).toBe(true);
    expect(props.prepareItem).toBe(prepare);
  });

  it('keeps prepareItem out of the section list', () => {
    const hidden: 'prepareItem' extends keyof NitroSectionListProps<unknown> ? false : true = true;

    expect(hidden).toBe(true);
  });
});
