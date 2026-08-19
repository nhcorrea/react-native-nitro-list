import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Image, Platform, Pressable, StyleSheet, Text, View} from 'react-native';

import {NitroList, type NitroListHandle, type NitroListRenderItem} from '../NitroList';
import {
  LatencyDistribution,
  NITRO_LIST_PERF_COMPILED,
  NitroListPerfMonitor,
  type NitroListPerfSnapshot,
} from '../PerfMonitor';

/**
 * Dev-only benchmark harness for NitroList.
 *
 * Mount it on a dev route, pick a dataset, and either scroll by hand or use
 * the scripted runs. "Dump" logs a JSON report to the console — paste it into
 * a results table. Metric definitions live in PerfMonitor.ts.
 *
 * The scripted run drives `scrollToOffset(animated: false)` from a rAF loop
 * at a fixed dp/s velocity, which exercises the same JS scroll path as a real
 * fling (engine offset + echoed onScroll events) with reproducible speed. JS
 * tick gaps during the run double as a JS-thread stall detector.
 *
 * Runs default to a fixed 30s duration so rows are comparable across datasets
 * (a full dynamic-10k sweep takes ~7min and used to depend on a manual Stop);
 * the `mode` button switches to the full down+up sweep.
 */

type DatasetKey = 'fixed-1k' | 'dynamic-1k' | 'dynamic-10k' | 'images-500';
type RunMode = 'fixed-30s' | 'sweep';

/**
 * Apps commonly strip `console.log` from production bundles
 * (`transform-remove-console`, exclude: error/warn) — which silently eats the
 * bench output in a release-bench build. Route it through `warn` there (kept
 * by the exclusion; lands in logcat as `W ReactNativeJS`); keep `log` in dev
 * for clean Metro formatting. The results row is also mirrored on screen as
 * selectable text, so logcat is optional.
 */
const benchLog: (...args: unknown[]) => void = __DEV__
  ? (...args) => console.log(...args)
  : (...args) => console.warn(...args);

/** Fixed-duration mode: run length in ms. */
const FIXED_RUN_DURATION_MS = 30_000;
/**
 * drawDistance options for the B5 experiment (500 vs 375/250 —
 * plan-improve-nitro-list-bench-v1). 500 stays the default for comparability
 * with existing rows; production screens use NitroList's default (250). The
 * logged scenario string always carries the active value (B0.5), plus a
 * ` f4` suffix when the experimental UI-thread scroll driver is on.
 */
const DRAW_DISTANCE_OPTIONS = [500, 375, 250] as const;

interface BenchItem {
  key: string;
  type: string;
  kind: 'fixed' | 'dynamic' | 'image';
  text: string;
  height: number;
  imageUri?: string;
}

const DATASETS: Record<DatasetKey, {count: number; estimatedItemSize: number}> = {
  'fixed-1k': {count: 1_000, estimatedItemSize: 64},
  // 80dp estimate vs 40–200dp real heights — deliberately imprecise so the
  // estimate/correction machinery actually gets exercised.
  'dynamic-1k': {count: 1_000, estimatedItemSize: 80},
  'dynamic-10k': {count: 10_000, estimatedItemSize: 80},
  'images-500': {count: 500, estimatedItemSize: 240},
};

function deterministicHeight(index: number): number {
  // Knuth multiplicative hash → stable pseudo-random 40..200 dp.
  return 40 + (((index * 2654435761) >>> 0) % 161);
}

function makeItems(dataset: DatasetKey): BenchItem[] {
  const {count} = DATASETS[dataset];
  const items: BenchItem[] = new Array(count);
  for (let i = 0; i < count; i++) {
    if (dataset === 'fixed-1k') {
      items[i] = {key: `f${i}`, type: 'fixed', kind: 'fixed', text: `Fixed row #${i}`, height: 64};
    } else if (dataset === 'images-500') {
      items[i] = {
        key: `img${i}`,
        type: 'image',
        kind: 'image',
        text: `Image row #${i}`,
        height: 240,
        imageUri: `https://picsum.photos/seed/nitro${i}/400/240`,
      };
    } else {
      const height = deterministicHeight(i);
      items[i] = {
        key: `d${i}`,
        type: `dyn${i % 3}`,
        kind: 'dynamic',
        text: `Dynamic row #${i} (${height}dp) — ${'lorem ipsum '.repeat(1 + (i % 4))}`,
        height,
      };
    }
  }
  return items;
}

interface RunReport {
  dataset: DatasetKey;
  mode: RunMode;
  velocityDpPerSec: number;
  durationMs: number;
  jsTicks: number;
  jsAvgTickMs: number;
  jsMaxTickMs: number;
  /** Tail of the rAF tick gaps (R0.2) — avg/max hide the individual stalls. */
  jsTickP50Ms: number;
  jsTickP95Ms: number;
  jsTickP99Ms: number;
  perf: NitroListPerfSnapshot;
}

/**
 * Formats a snapshot as a ready-to-paste markdown results-table row. Device
 * is a best-effort guess — edit it to the real model when pasting.
 */
function toPerfRow(
  dataset: DatasetKey,
  scenario: string,
  s: NitroListPerfSnapshot,
  run?: {jsAvgTickMs: number; jsMaxTickMs: number; jsTickP95Ms: number; jsTickP99Ms: number},
): string {
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const date = new Date().toISOString().slice(0, 10);
  const device =
    Platform.OS === 'android'
      ? ((Platform.constants as {Model?: string}).Model ?? 'android')
      : `iOS ${Platform.Version}`;
  const blank = `${s.blankSamples}/${Math.round(s.blankPxMax)}/${Math.round(s.blankPxSum)}`;
  const rangeLat =
    s.rangeLatencySamples > 0
      ? `${r1(s.rangeLatencySumMs / s.rangeLatencySamples)}/${r1(s.rangeLatencyMaxMs)}`
      : '–';
  const jsiPerSec = s.windowMs > 0 ? Math.round((s.jsiCalls / s.windowMs) * 1000) : 0;
  const batch =
    s.batchFlushes > 0 ? `${r1(s.batchPairsSum / s.batchFlushes)}/${s.batchPairsMax}` : '–';
  const jsTick = run ? `${run.jsAvgTickMs}/${run.jsMaxTickMs}` : '–';
  const firstRange = s.firstRangeLatencyMs != null ? `${Math.round(s.firstRangeLatencyMs)}` : '–';
  const sti = s.lastScrollToIndex
    ? `${s.lastScrollToIndex.durationMs}/${s.lastScrollToIndex.correctionPasses}`
    : '–';
  // Régua v3 (R0.2/R0.3): tail columns appended after STI.
  const rangeLatTail =
    s.rangeLatencyTail.count > 0
      ? `${r1(s.rangeLatencyTail.p95)}/${r1(s.rangeLatencyTail.p99)}`
      : '–';
  const jsTickTail = run ? `${r1(run.jsTickP95Ms)}/${r1(run.jsTickP99Ms)}` : '–';
  const burst =
    s.mountBurst.count > 0 ? `${Math.round(s.mountBurst.p95)}/${Math.round(s.mountBurst.max)}` : '–';
  return `| ${date} | ${device} | ${dataset} | ${scenario} | ${blank} | ${rangeLat} | ${jsiPerSec} | ${batch} | ${s.itemMounts} | ${jsTick} | ${firstRange} | ${sti} | ${rangeLatTail} | ${jsTickTail} | ${burst} |`;
}

export function NitroListBenchmarkScreen() {
  const [dataset, setDataset] = useState<DatasetKey>('dynamic-1k');
  const [remountKey, setRemountKey] = useState(0);
  const [snapshot, setSnapshot] = useState<NitroListPerfSnapshot | null>(null);
  const [lastReport, setLastReport] = useState<RunReport | null>(null);
  const [running, setRunning] = useState(false);
  const [runMode, setRunMode] = useState<RunMode>('fixed-30s');
  // Last emitted results row, mirrored on screen (selectable → long-press to
  // copy) so release-bench runs don't depend on logcat at all.
  const [lastRow, setLastRow] = useState<string | null>(null);
  const [drawDistance, setDrawDistance] = useState<number>(DRAW_DISTANCE_OPTIONS[0]);
  // F4 evaluation (experimentalUiThreadScroll): only affects real gestures —
  // the scripted run drives scroll from JS, so compare F4 on/off by finger
  // fling on a JS-saturated device (the scenario F4 was built for).
  const [uiThreadScroll, setUiThreadScroll] = useState(false);
  const scenarioSuffix = `@dd${drawDistance}${uiThreadScroll ? ' f4' : ''}`;

  const listRef = useRef<NitroListHandle>(null);
  const runAbortRef = useRef(false);

  const items = useMemo(() => makeItems(dataset), [dataset]);
  const {estimatedItemSize} = DATASETS[dataset];

  useEffect(() => {
    NitroListPerfMonitor.enable();
    const interval = setInterval(() => {
      setSnapshot(NitroListPerfMonitor.getSnapshot());
    }, 500);
    return () => {
      clearInterval(interval);
      NitroListPerfMonitor.disable();
    };
  }, []);

  const renderItem = useCallback<NitroListRenderItem<BenchItem>>(({item}) => {
    if (item.kind === 'image') {
      return (
        <View style={[styles.row, {height: item.height}]}>
          <Image source={{uri: item.imageUri}} style={styles.rowImage} resizeMode="cover" />
          <Text style={styles.rowImageLabel}>{item.text}</Text>
        </View>
      );
    }
    return (
      <View style={[styles.row, {height: item.height}, item.kind === 'fixed' && styles.rowFixed]}>
        <Text numberOfLines={3} style={styles.rowText}>
          {item.text}
        </Text>
      </View>
    );
  }, []);

  const keyExtractor = useCallback((item: BenchItem) => item.key, []);
  const getItemType = useCallback((item: BenchItem) => item.type, []);

  const runScrollTest = useCallback(
    (velocityDpPerSec: number) => {
      const list = listRef.current;
      if (!list || running) return;
      setRunning(true);
      runAbortRef.current = false;
      NitroListPerfMonitor.reset();

      const mode = runMode;
      const scenario = `${velocityDpPerSec / 1000}k dp/s ${
        mode === 'fixed-30s' ? '30s' : 'sweep'
      } ${scenarioSuffix}`;
      const viewportH = list.getWindowSize().height;
      const startedAt = Date.now();
      let offset = 0;
      let direction: 1 | -1 = 1;
      let lastTick = Date.now();
      let ticks = 0;
      let maxGap = 0;
      const tickGaps = new LatencyDistribution();

      list.scrollToOffset({offset: 0, animated: false});

      const finish = () => {
        const durationMs = Date.now() - startedAt;
        const gapTail = tickGaps.snapshot();
        const report: RunReport = {
          dataset,
          mode,
          velocityDpPerSec,
          durationMs,
          jsTicks: ticks,
          jsAvgTickMs: ticks > 0 ? Math.round((durationMs / ticks) * 10) / 10 : 0,
          jsMaxTickMs: Math.round(maxGap * 10) / 10,
          jsTickP50Ms: Math.round(gapTail.p50 * 10) / 10,
          jsTickP95Ms: Math.round(gapTail.p95 * 10) / 10,
          jsTickP99Ms: Math.round(gapTail.p99 * 10) / 10,
          perf: NitroListPerfMonitor.getSnapshot(),
        };
        setLastReport(report);
        setRunning(false);
        const row = toPerfRow(dataset, scenario, report.perf, report);
        setLastRow(row);
        benchLog('[NitroListBenchmark]', JSON.stringify(report, null, 2));
        benchLog('[NitroListBenchmark] results row:\n' + row);
      };

      const step = () => {
        if (runAbortRef.current || !listRef.current) {
          finish();
          return;
        }
        const now = Date.now();
        if (mode === 'fixed-30s' && now - startedAt >= FIXED_RUN_DURATION_MS) {
          finish();
          return;
        }
        // Clamp dt so background hiccups don't teleport the offset.
        const dt = Math.min(now - lastTick, 64);
        if (now !== lastTick) {
          maxGap = Math.max(maxGap, now - lastTick);
          // Unclamped gap: the tail must see the real stall, not the 64ms cap.
          tickGaps.record(now - lastTick);
        }
        lastTick = now;
        ticks++;
        offset += direction * (velocityDpPerSec * dt) / 1000;
        // Recomputed live: with imprecise estimates the total size shifts as
        // cells get measured during the run.
        const maxOffset = Math.max(0, listRef.current.getTotalSize() - viewportH);
        if (direction === 1 && offset >= maxOffset) {
          offset = maxOffset;
          direction = -1;
        } else if (direction === -1 && offset <= 0) {
          listRef.current.scrollToOffset({offset: 0, animated: false});
          finish();
          return;
        }
        listRef.current.scrollToOffset({offset, animated: false});
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    [dataset, running, runMode, scenarioSuffix],
  );

  const runScrollToIndexTest = useCallback(() => {
    const list = listRef.current;
    if (!list || running) return;
    NitroListPerfMonitor.reset();
    // Far jump from wherever we are — exercises prewarm + corrections.
    const target = Math.floor(items.length * 0.85);
    void list.scrollToIndex({index: target, animated: false, viewPosition: 0.5}).then(() => {
      const snap = NitroListPerfMonitor.getSnapshot();
      setSnapshot(snap);
      const row = toPerfRow(dataset, `scrollToIndex ${scenarioSuffix}`, snap);
      setLastRow(row);
      benchLog('[NitroListBenchmark] results row:\n' + row);
    });
  }, [dataset, items.length, running, scenarioSuffix]);

  const stop = useCallback(() => {
    runAbortRef.current = true;
  }, []);

  const remount = useCallback(() => {
    NitroListPerfMonitor.reset();
    setRemountKey((k) => k + 1);
  }, []);

  const dump = useCallback(() => {
    const snap = NitroListPerfMonitor.getSnapshot();
    setSnapshot(snap);
    const payload = {dataset, snapshot: snap, lastReport};
    // Manual scroll has no scripted-run jsTick numbers — the row shows '–'.
    const row = toPerfRow(dataset, `manual ${scenarioSuffix}`, snap);
    setLastRow(row);
    benchLog('[NitroListBenchmark]', JSON.stringify(payload, null, 2));
    benchLog('[NitroListBenchmark] results row:\n' + row);
  }, [dataset, lastReport, scenarioSuffix]);

  if (!NITRO_LIST_PERF_COMPILED) {
    return null;
  }

  const s = snapshot;
  const avgBatch =
    s && s.batchFlushes > 0 ? Math.round((s.batchPairsSum / s.batchFlushes) * 10) / 10 : 0;

  return (
    <View style={styles.container}>
      <View style={styles.controls}>
        <View style={styles.buttonRow}>
          {(Object.keys(DATASETS) as DatasetKey[]).map((key) => (
            <Pressable
              key={key}
              onPress={() => {
                setDataset(key);
                remount();
              }}
              style={[styles.button, dataset === key && styles.buttonActive]}>
              <Text style={styles.buttonText}>{key}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.buttonRow}>
          <Pressable onPress={() => runScrollTest(2000)} style={styles.button}>
            <Text style={styles.buttonText}>Run 2k dp/s</Text>
          </Pressable>
          <Pressable onPress={() => runScrollTest(6000)} style={styles.button}>
            <Text style={styles.buttonText}>Run 6k dp/s</Text>
          </Pressable>
          <Pressable onPress={runScrollToIndexTest} style={styles.button}>
            <Text style={styles.buttonText}>scrollToIndex</Text>
          </Pressable>
          <Pressable
            onPress={() => setRunMode((m) => (m === 'fixed-30s' ? 'sweep' : 'fixed-30s'))}
            style={styles.button}>
            <Text style={styles.buttonText}>
              {runMode === 'fixed-30s' ? 'mode: 30s' : 'mode: sweep'}
            </Text>
          </Pressable>
          {running ? (
            <Pressable onPress={stop} style={[styles.button, styles.buttonStop]}>
              <Text style={styles.buttonText}>Stop</Text>
            </Pressable>
          ) : (
            <Pressable onPress={remount} style={styles.button}>
              <Text style={styles.buttonText}>Remount</Text>
            </Pressable>
          )}
          <Pressable onPress={dump} style={styles.button}>
            <Text style={styles.buttonText}>Dump</Text>
          </Pressable>
        </View>
        <View style={styles.buttonRow}>
          {DRAW_DISTANCE_OPTIONS.map((dd) => (
            <Pressable
              key={dd}
              onPress={() => {
                setDrawDistance(dd);
                remount();
              }}
              style={[styles.button, drawDistance === dd && styles.buttonActive]}>
              <Text style={styles.buttonText}>dd{dd}</Text>
            </Pressable>
          ))}
          <Pressable
            onPress={() => {
              setUiThreadScroll((v) => !v);
              remount();
            }}
            style={[styles.button, uiThreadScroll && styles.buttonActive]}>
            <Text style={styles.buttonText}>F4: {uiThreadScroll ? 'on' : 'off'}</Text>
          </Pressable>
        </View>
        {s ? (
          <Text style={styles.stats}>
            blank: {s.blankSamples}/{s.scrollSamples} samples · max {Math.round(s.blankPxMax)}dp ·
            Σ{Math.round(s.blankPxSum)}dp{'\n'}
            batches: {s.batchFlushes} (avg {avgBatch}, max {s.batchPairsMax} pairs) · ranges:{' '}
            {s.rangeEvents}{'\n'}
            mounts: {s.itemMounts} · unmounts: {s.itemUnmounts} · renders: {s.itemRenders}
            {'\n'}
            firstRange: {s.firstRangeLatencyMs ?? '–'}ms · STI:{' '}
            {s.lastScrollToIndex
              ? `${s.lastScrollToIndex.durationMs}ms/${s.lastScrollToIndex.correctionPasses}p/${s.lastScrollToIndex.prewarmRestarts}r`
              : '–'}
            {'\n'}
            burst p50/p95/max:{' '}
            {s.mountBurst.count > 0
              ? `${Math.round(s.mountBurst.p50)}/${Math.round(s.mountBurst.p95)}/${Math.round(s.mountBurst.max)} (${s.mountBurst.count} commits)`
              : '–'}{' '}
            · rangeLat p95/p99:{' '}
            {s.rangeLatencyTail.count > 0
              ? `${Math.round(s.rangeLatencyTail.p95)}/${Math.round(s.rangeLatencyTail.p99)}ms`
              : '–'}
            {lastReport
              ? `\nrun: ${lastReport.velocityDpPerSec}dp/s · jsTick avg ${lastReport.jsAvgTickMs} p95 ${lastReport.jsTickP95Ms} p99 ${lastReport.jsTickP99Ms} max ${lastReport.jsMaxTickMs}ms`
              : ''}
          </Text>
        ) : null}
        {lastRow != null ? (
          // Long-press to copy — the release bench doesn't depend on logcat.
          <Text selectable style={styles.rowOutput}>
            {lastRow}
          </Text>
        ) : null}
      </View>
      <View style={styles.listWrapper}>
        <NitroList<BenchItem>
          key={`${dataset}-${remountKey}`}
          ref={listRef}
          data={items}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          getItemType={getItemType}
          estimatedItemSize={estimatedItemSize}
          drawDistance={drawDistance}
          experimentalUiThreadScroll={uiThreadScroll}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111',
  },
  controls: {
    paddingTop: 56,
    paddingHorizontal: 8,
    paddingBottom: 8,
    backgroundColor: '#1c1c1e',
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 6,
  },
  button: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#3a3a3c',
  },
  buttonActive: {
    backgroundColor: '#0a84ff',
  },
  buttonStop: {
    backgroundColor: '#ff453a',
  },
  buttonText: {
    color: '#fff',
    fontSize: 12,
  },
  stats: {
    color: '#7dff9b',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  rowOutput: {
    color: '#ffd60a',
    fontSize: 10,
    marginTop: 4,
    fontVariant: ['tabular-nums'],
  },
  listWrapper: {
    flex: 1,
  },
  row: {
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
    backgroundColor: '#1a1a1a',
    overflow: 'hidden',
  },
  rowFixed: {
    backgroundColor: '#16202a',
  },
  rowText: {
    color: '#ddd',
    fontSize: 13,
  },
  rowImage: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  rowImageLabel: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    textShadowColor: '#000',
    textShadowRadius: 4,
  },
});
