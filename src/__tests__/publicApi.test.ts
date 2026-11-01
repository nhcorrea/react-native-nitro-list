import {describe, expect, it} from '@jest/globals';

import type {NitroListProps} from '../index';

describe('public API', () => {
  it('does not expose the experimental prepareItem prop', () => {
    const withoutPrepareItem: 'prepareItem' extends keyof NitroListProps<unknown> ? false : true = true;
    expect(withoutPrepareItem).toBe(true);
  });
});
