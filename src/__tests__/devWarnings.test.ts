import {afterEach, describe, expect, it, jest} from '@jest/globals';

import {clearWarnDevOnceForTests, warnDevOnce} from '../devWarnings';

describe('warnDevOnce', () => {
  afterEach(() => {
    clearWarnDevOnceForTests();
    jest.restoreAllMocks();
  });

  it('warns once per id with the library prefix', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    warnDevOnce('a', 'first');
    warnDevOnce('a', 'first again');
    warnDevOnce('b', 'second');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, '[nitro-list] first');
    expect(warn).toHaveBeenNthCalledWith(2, '[nitro-list] second');
  });

  it('warns again after the test-only reset', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    warnDevOnce('a', 'first');
    clearWarnDevOnceForTests();
    warnDevOnce('a', 'first');
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
