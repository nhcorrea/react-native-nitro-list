import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {
  accumulateEstimateDriftSample,
  checkDuplicateKeyDev,
  clearWarnDevOnceForTests,
  ESTIMATE_DRIFT_MIN_SAMPLES,
  maybeWarnEstimateDrift,
  maybeWarnJsOnScrollUnderUiDriver,
  maybeWarnMissingKeyExtractor,
  maybeWarnZeroViewport,
  warnDevOnce,
  type EstimateDriftStats,
} from '../devWarnings';

let warn: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  clearWarnDevOnceForTests();
  jest.restoreAllMocks();
});

describe('warnDevOnce', () => {
  it('warns once per id with the library prefix', () => {
    warnDevOnce('a', 'first');
    warnDevOnce('a', 'first again');
    warnDevOnce('b', 'second');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, '[nitro-list] first');
    expect(warn).toHaveBeenNthCalledWith(2, '[nitro-list] second');
  });

  it('warns again after the test-only reset', () => {
    warnDevOnce('a', 'first');
    clearWarnDevOnceForTests();
    warnDevOnce('a', 'first');
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('W1 · maybeWarnMissingKeyExtractor', () => {
  it('warns when data changes without a keyExtractor', () => {
    maybeWarnMissingKeyExtractor(false, 10, 12);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('keyExtractor');
  });

  it('stays silent with a keyExtractor or around empty transitions', () => {
    maybeWarnMissingKeyExtractor(true, 10, 12);
    maybeWarnMissingKeyExtractor(false, 0, 12);
    maybeWarnMissingKeyExtractor(false, 10, 0);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('W2 · checkDuplicateKeyDev', () => {
  it('warns with the offending key on a duplicate', () => {
    const seen = new Set<string>();
    checkDuplicateKeyDev(seen, 'msg-1');
    checkDuplicateKeyDev(seen, 'msg-2');
    expect(warn).not.toHaveBeenCalled();
    checkDuplicateKeyDev(seen, 'msg-1');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"msg-1"');
  });
});

describe('W3 · maybeWarnZeroViewport', () => {
  it('warns when data is present but the viewport never measured', () => {
    maybeWarnZeroViewport(0, 100);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('height');
  });

  it('stays silent with a measured viewport or an empty list', () => {
    maybeWarnZeroViewport(600, 100);
    maybeWarnZeroViewport(0, 0);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('W4 · estimate drift', () => {
  it('suggests the measured mean after enough samples with >40% drift', () => {
    const stats = new Map<string, EstimateDriftStats>();
    for (let i = 0; i < ESTIMATE_DRIFT_MIN_SAMPLES; i++) {
      accumulateEstimateDriftSample(stats, 'message', 200, 100);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('estimatedItemSize=100');
    expect(warn.mock.calls[0][0]).toContain('≈200');
    expect(warn.mock.calls[0][0]).toContain('"message"');
  });

  it('stays silent below the sample floor or drift threshold', () => {
    const stats = new Map<string, EstimateDriftStats>();
    for (let i = 0; i < ESTIMATE_DRIFT_MIN_SAMPLES - 1; i++) {
      accumulateEstimateDriftSample(stats, 'a', 200, 100);
    }
    for (let i = 0; i < ESTIMATE_DRIFT_MIN_SAMPLES * 2; i++) {
      accumulateEstimateDriftSample(stats, 'b', 120, 100);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('dedupes per type and labels the untyped bucket without a type name', () => {
    maybeWarnEstimateDrift('', 250, ESTIMATE_DRIFT_MIN_SAMPLES, 100);
    maybeWarnEstimateDrift('', 250, ESTIMATE_DRIFT_MIN_SAMPLES + 1, 100);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).not.toContain('type "');
  });
});

describe('W5 · maybeWarnJsOnScrollUnderUiDriver', () => {
  it('warns only when a JS onScroll rides the UI-thread driver', () => {
    maybeWarnJsOnScrollUnderUiDriver(true, false);
    maybeWarnJsOnScrollUnderUiDriver(false, true);
    expect(warn).not.toHaveBeenCalled();
    maybeWarnJsOnScrollUnderUiDriver(true, true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('onScrollWorklet');
  });
});
