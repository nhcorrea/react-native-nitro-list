import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {renderNitroList, type NitroListHarness} from './helpers/harness';

type Msg = {id: string; type: string; text: string; height: number};

const COUNT = 500;
const VIEWPORT_W = 400;
const VIEWPORT_H = 800;

function messages(count: number): Msg[] {
  return Array.from({length: count}, (_, i) => ({
    id: `m${i}`,
    type: `kind${i % 3}`,
    text: `message ${i}`,
    height: 60 + ((i * 37) % 80),
  }));
}

describe('engine calls on a chat stream (fronteira 1.9)', () => {
  let harness: NitroListHarness<Msg> | undefined;
  let msgs: Msg[];

  const listProps = () => ({
    data: msgs,
    renderItem: () => null,
    keyExtractor: (item: Msg) => item.id,
    getItemType: (item: Msg) => item.type,
    estimatedItemSize: 80,
    drawDistance: 500,
    maintainScrollAtEnd: true,
    anchoredEndSpace: {anchorIndex: msgs.length - 1},
  });

  async function mountAtEnd(): Promise<NitroListHarness<Msg>> {
    msgs = messages(COUNT);
    const active = renderNitroList<Msg>(listProps());
    active.layout(VIEWPORT_W, VIEWPORT_H);
    active.measureAllCells((i) => msgs[i].height);
    await active.settle(50);
    const landing = active.handle.scrollToEnd(false);
    await active.settle(2000);
    await landing;
    for (let round = 0; round < 4; round++) {
      active.measureUnmeasuredCells((i) => msgs[i].height);
      await active.settle(50);
    }
    return active;
  }

  const calls = (name: string) => harness!.mirror.callLog.filter((call) => call === name).length;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    harness?.unmount();
    harness = undefined;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('streams tokens into the last message without data commits or type seeding', async () => {
    harness = await mountAtEnd();
    harness.mirror.callLog.length = 0;
    const TICKS = 24;
    for (let token = 1; token <= TICKS; token++) {
      const grow = token % 8 === 0 ? 20 : 0;
      const next = msgs.slice();
      const last = next[next.length - 1];
      next[next.length - 1] = {...last, text: `${last.text} tok${token}`, height: last.height + grow};
      msgs = next;
      harness.update(listProps());
      await harness.settle(25);
      if (grow > 0) harness.measureCell(msgs.length - 1, msgs[msgs.length - 1].height);
      await harness.settle(25);
    }
    expect(calls('updateData')).toBe(0);
    expect(calls('seedTypeMeans')).toBe(0);
    expect(calls('fillLayoutSlab')).toBe(0);
    expect(calls('setItemSizesAndFill')).toBe(TICKS / 8);
    expect(harness.handle.getItemSize(msgs.length - 1)).toBe(msgs[msgs.length - 1].height);
  });

  it('still commits appended messages to the engine once each', async () => {
    harness = await mountAtEnd();
    harness.mirror.callLog.length = 0;
    for (let k = 0; k < 3; k++) {
      msgs = [...msgs, {id: `n${k}`, type: 'kind0', text: `new ${k}`, height: 90}];
      harness.update(listProps());
      await harness.settle(25);
      harness.measureUnmeasuredCells((i) => msgs[i].height);
      await harness.settle(25);
    }
    expect(calls('updateData')).toBe(3);
    expect(harness.handle.getTotalSize()).toBeGreaterThan(COUNT * 60);
  });
});
