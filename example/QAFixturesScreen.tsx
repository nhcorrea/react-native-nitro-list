import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  NitroList,
  NitroListPerfMonitor,
  type NitroListHandle,
  type NitroListRenderItem,
} from '@nhcorrea/react-native-nitro-list';

type QAItem = { id: string; ordinal: number };

type FixtureState = 'idle' | 'running' | 'pass' | 'fail';

const ITEM_COUNT = 10_000;
const ESTIMATED_SIZE = 64;

function heightForOrdinal(ordinal: number): number {
  return 44 + ((ordinal * 37) % 5) * 18;
}

function makeQAItems(count: number, firstOrdinal: number): QAItem[] {
  const items: QAItem[] = [];
  for (let i = 0; i < count; i++) {
    const ordinal = firstOrdinal + i;
    items.push({ id: `qa-${ordinal}`, ordinal });
  }
  return items;
}

function StatusBadge({ name, state, detail }: { name: string; state: FixtureState; detail: string }) {
  const label =
    state === 'pass' ? 'PASS' : state === 'fail' ? 'FAIL' : state === 'running' ? '…' : 'idle';
  return (
    <View style={styles.badgeRow}>
      <View
        testID={state === 'pass' ? `qa-${name}-pass` : `qa-${name}-${state}`}
        style={[
          styles.badge,
          state === 'pass' ? styles.badgePass : state === 'fail' ? styles.badgeFail : styles.badgeIdle,
        ]}
      >
        <Text style={styles.badgeText}>{label}</Text>
      </View>
      <Text style={styles.badgeDetail}>
        {name} · {detail}
      </Text>
    </View>
  );
}

function QAFixturesScreen({ onExit }: { onExit: () => void }) {
  const listRef = useRef<NitroListHandle>(null);
  const [items, setItems] = useState<QAItem[]>(() => makeQAItems(ITEM_COUNT, 0));
  const nextPrependOrdinalRef = useRef(-1);

  const [flingState, setFlingState] = useState<FixtureState>('running');
  const [flingDetail, setFlingDetail] = useState('fling the list, then stop');
  const [indexState, setIndexState] = useState<FixtureState>('idle');
  const [indexDetail, setIndexDetail] = useState('scrollToIndex(7333) lands exactly');
  const [endState, setEndState] = useState<FixtureState>('idle');
  const [endDetail, setEndDetail] = useState('scrollToEnd lands at max offset');
  const [prependState, setPrependState] = useState<FixtureState>('idle');
  const [prependDetail, setPrependDetail] = useState('MVCP holds anchor across 10 prepends');

  useEffect(() => {
    NitroListPerfMonitor.enable();
    return () => NitroListPerfMonitor.disable();
  }, []);

  const keyExtractor = useCallback((item: QAItem) => item.id, []);
  const renderItem = useMemo<NitroListRenderItem<QAItem>>(
    () =>
      ({ item }) => (
        <View style={[styles.row, { height: heightForOrdinal(item.ordinal) }]}>
          <Text style={styles.rowText}>
            #{item.ordinal} · h{heightForOrdinal(item.ordinal)}
          </Text>
        </View>
      ),
    []
  );

  const onMomentumScrollEnd = useCallback(() => {
    const s = NitroListPerfMonitor.getSnapshot();
    if (s.scrollSamples < 60) {
      setFlingDetail(`need a longer fling (${s.scrollSamples} samples)`);
      return;
    }
    const blankRatio = s.blankSamples / s.scrollSamples;
    const ok = blankRatio <= 0.02;
    setFlingState(ok ? 'pass' : 'fail');
    setFlingDetail(
      `blank ${s.blankSamples}/${s.scrollSamples} (max ${Math.round(s.blankPxMax)}px)`
    );
  }, []);

  const runScrollToIndex = useCallback(async () => {
    const handle = listRef.current;
    if (!handle) return;
    setIndexState('running');
    await handle.scrollToIndex({ index: 7333 });
    await new Promise<void>(resolve => setTimeout(resolve, 120));
    const target = handle.getFirstItemOffset() + handle.getItemOffset(7333);
    const actual = handle.getAbsoluteLastScrollOffset();
    const delta = Math.abs(actual - target);
    setIndexState(delta <= 1 ? 'pass' : 'fail');
    setIndexDetail(`Δ ${delta.toFixed(2)}dp (target ${Math.round(target)})`);
  }, []);

  const runScrollToEnd = useCallback(() => {
    const handle = listRef.current;
    if (!handle) return;
    setEndState('running');
    handle.scrollToEnd(false);
    setTimeout(() => {
      const h = listRef.current;
      if (!h) return;
      const max =
        h.getFirstItemOffset() + h.getTotalSize() - h.getWindowSize().height;
      const actual = h.getAbsoluteLastScrollOffset();
      const delta = Math.abs(actual - Math.max(0, max));
      setEndState(delta <= 1 ? 'pass' : 'fail');
      setEndDetail(`Δ ${delta.toFixed(2)}dp of ${Math.round(max)}`);
    }, 1200);
  }, []);

  const runMvcpPrepend = useCallback(() => {
    const handle = listRef.current;
    if (!handle) return;
    setPrependState('running');
    let round = 0;
    let maxDrift = 0;
    const step = () => {
      const h = listRef.current;
      if (!h) return;
      setItems(prev => {
        const scrollY = h.getAbsoluteLastScrollOffset();
        const first = h.getFirstItemOffset();
        let anchorIndex = 0;
        while (
          anchorIndex < prev.length - 1 &&
          first + h.getItemOffset(anchorIndex) < scrollY
        ) {
          anchorIndex++;
        }
        const anchorId = prev[anchorIndex].id;
        const screenPosBefore = first + h.getItemOffset(anchorIndex) - scrollY;
        const batch = makeQAItems(5, nextPrependOrdinalRef.current - 4);
        nextPrependOrdinalRef.current -= 5;
        const next = [...batch, ...prev];
        setTimeout(() => {
          const h2 = listRef.current;
          if (!h2) return;
          const newIndex = next.findIndex(item => item.id === anchorId);
          if (newIndex < 0) return;
          const screenPosAfter =
            h2.getFirstItemOffset() +
            h2.getItemOffset(newIndex) -
            h2.getAbsoluteLastScrollOffset();
          const drift = Math.abs(screenPosAfter - screenPosBefore);
          maxDrift = Math.max(maxDrift, drift);
          round++;
          if (round >= 10) {
            const ok = maxDrift <= 2;
            setPrependState(ok ? 'pass' : 'fail');
            setPrependDetail(`max drift ${maxDrift.toFixed(2)}dp over ${round} prepends`);
          } else {
            setPrependDetail(`round ${round}/10 · drift ${maxDrift.toFixed(2)}dp`);
            setTimeout(step, 350);
          }
        }, 350);
        return next;
      });
    };
    step();
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.headerTitle}>QA fixtures</Text>
          <Pressable testID="qa-exit" style={styles.exit} onPress={onExit}>
            <Text style={styles.exitText}>back</Text>
          </Pressable>
        </View>
        <StatusBadge name="fling-blank" state={flingState} detail={flingDetail} />
        <StatusBadge name="scroll-to-index" state={indexState} detail={indexDetail} />
        <StatusBadge name="scroll-to-end" state={endState} detail={endDetail} />
        <StatusBadge name="mvcp-prepend" state={prependState} detail={prependDetail} />
        <View style={styles.buttonRow}>
          <Pressable testID="qa-scroll-to-index-run" style={styles.button} onPress={runScrollToIndex}>
            <Text style={styles.buttonText}>toIndex</Text>
          </Pressable>
          <Pressable testID="qa-scroll-to-end-run" style={styles.button} onPress={runScrollToEnd}>
            <Text style={styles.buttonText}>toEnd</Text>
          </Pressable>
          <Pressable testID="qa-mvcp-prepend-run" style={styles.button} onPress={runMvcpPrepend}>
            <Text style={styles.buttonText}>prepend</Text>
          </Pressable>
        </View>
      </View>
      <NitroList
        ref={listRef}
        data={items}
        renderItem={renderItem}
        estimatedItemSize={ESTIMATED_SIZE}
        keyExtractor={keyExtractor}
        maintainVisibleContentPosition
        onMomentumScrollEnd={onMomentumScrollEnd}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    paddingTop: 56,
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ccc',
    gap: 6,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  exit: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: '#eee',
  },
  exitText: {
    fontSize: 13,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  badge: {
    width: 52,
    borderRadius: 8,
    paddingVertical: 2,
    alignItems: 'center',
  },
  badgePass: {
    backgroundColor: '#1f8a3b',
  },
  badgeFail: {
    backgroundColor: '#c0392b',
  },
  badgeIdle: {
    backgroundColor: '#999',
  },
  badgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  badgeDetail: {
    fontSize: 12,
    color: '#333',
    flexShrink: 1,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
  },
  button: {
    backgroundColor: '#2c5fa8',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  buttonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  row: {
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  rowText: {
    fontSize: 14,
    color: '#222',
  },
});

export default QAFixturesScreen;
