import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Image, Platform, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import Animated from 'react-native-reanimated';

import {
  NitroList,
  type NitroListHandle,
  type NitroListRenderItem,
  type NitroListRenderScrollComponentProps,
} from '../NitroList';
import {
  LatencyDistribution,
  NITRO_LIST_PERF_COMPILED,
  NitroListPerfMonitor,
  type NitroListPerfSnapshot,
} from '../PerfMonitor';
import {clearMeasurementCache} from '../measurementCache';
import {NITRO_LIST_DEV_FLAG_KEYS, NitroListDevFlags, type NitroListDevFlagKey} from '../devFlags';

type DatasetKey =
  | 'fixed-1k'
  | 'dynamic-1k'
  | 'dynamic-10k'
  | 'images-500'
  | 'dynamic-100k'
  | 'chat-5k';
type RunMode = 'fixed-30s' | 'sweep';
type ScrollDriver = 'scripted' | 'finger-like';

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') {
    ref(value);
  } else if (ref != null) {
    (ref as React.MutableRefObject<T | null>).current = value;
  }
}

const benchLog: (...args: unknown[]) => void = __DEV__
  ? (...args) => console.log(...args)
  : (...args) => console.warn(...args);

const FIXED_RUN_DURATION_MS = 30_000;
const STREAM_INTERVAL_MS = 50;
const STI_REPOSITION_SETTLE_MS = 500;
const DRAW_DISTANCE_OPTIONS = [500, 375, 250] as const;
const JS_LOAD_OPTIONS = [0, 4, 8] as const;

const MATRIX_REPS = 3;
const MATRIX_SETTLE_MS = 900;
const MATRIX_IMAGE_SETTLE_MS = 2_500;
const MATRIX_COOLDOWN_MS = 1_500;
const LIST_READY_TIMEOUT_MS = 8_000;

function logStiPhases(snapshot: NitroListPerfSnapshot): void {
  const phases = snapshot.lastScrollToIndex?.phases;
  if (phases) benchLog('[NitroListBenchmark] sti phases: ' + phases);
}

const DEV_FLAG_LABELS: Record<NitroListDevFlagKey, string> = {
  stiEventDrivenWait: 'sti',
  scrollEchoGuard: 'echo',
  staleRangeReconcile: 'stale',
  rangeEdgeHysteresis: 'hyst',
  stiLandingAdmission: 'adm',
  stiLayoutEffectWaiter: 'lew',
  dataAppendFastPath: 'app',
  jsScrollEventThrottle1: 'thr1',
};

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
  'dynamic-1k': {count: 1_000, estimatedItemSize: 80},
  'dynamic-10k': {count: 10_000, estimatedItemSize: 80},
  'images-500': {count: 500, estimatedItemSize: 240},
  'dynamic-100k': {count: 100_000, estimatedItemSize: 80},
  'chat-5k': {count: 5_000, estimatedItemSize: 80},
};

type MatrixKind = 'scroll' | 'sti' | 'mount' | 'stream';

interface MatrixCell {
  id: string;
  dataset: DatasetKey;
  kind: MatrixKind;
  velocityDpPerSec?: number;
  coldCache?: boolean;
  fixedSizes?: boolean;
  suffix?: string;
}

const MATRIX: MatrixCell[] = [
  {id: '7a', dataset: 'fixed-1k', kind: 'scroll', velocityDpPerSec: 2_000, coldCache: true, suffix: 'frio'},
  {id: '1', dataset: 'fixed-1k', kind: 'scroll', velocityDpPerSec: 2_000},
  {id: '1b', dataset: 'fixed-1k', kind: 'scroll', velocityDpPerSec: 2_000, fixedSizes: true, suffix: 'fixed'},
  {id: '7b', dataset: 'dynamic-1k', kind: 'scroll', velocityDpPerSec: 2_000, coldCache: true, suffix: 'frio'},
  {id: '2', dataset: 'dynamic-1k', kind: 'scroll', velocityDpPerSec: 2_000},
  {id: '3', dataset: 'dynamic-10k', kind: 'scroll', velocityDpPerSec: 6_000},
  {id: '4', dataset: 'images-500', kind: 'scroll', velocityDpPerSec: 2_000},
  {id: '5', dataset: 'dynamic-10k', kind: 'sti'},
  {id: '6a', dataset: 'fixed-1k', kind: 'mount'},
  {id: '6b', dataset: 'dynamic-1k', kind: 'mount'},
  {id: '6c', dataset: 'dynamic-10k', kind: 'mount'},
  {id: '6d', dataset: 'images-500', kind: 'mount'},
  {id: '8', dataset: 'dynamic-100k', kind: 'scroll', velocityDpPerSec: 6_000},
  {id: '8b', dataset: 'dynamic-100k', kind: 'sti'},
  {id: '9', dataset: 'chat-5k', kind: 'stream'},
];

function stiTargetIndex(dataset: DatasetKey): number {
  if (dataset === 'dynamic-100k') return 95_000;
  return Math.floor(DATASETS[dataset].count * 0.85);
}

function deterministicHeight(index: number): number {
  return 40 + (((index * 2654435761) >>> 0) % 161);
}

function datasetHeight(dataset: DatasetKey, index: number): number {
  if (dataset === 'fixed-1k') return 64;
  if (dataset === 'images-500') return 240;
  return deterministicHeight(index);
}

function makeItems(dataset: DatasetKey): BenchItem[] {
  const {count} = DATASETS[dataset];
  const items: BenchItem[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const height = datasetHeight(dataset, i);
    if (dataset === 'fixed-1k') {
      items[i] = {key: `f${i}`, type: 'fixed', kind: 'fixed', text: `Fixed row #${i}`, height};
    } else if (dataset === 'images-500') {
      items[i] = {
        key: `img${i}`,
        type: 'image',
        kind: 'image',
        text: `Image row #${i}`,
        height,
        imageUri: `https://picsum.photos/seed/nitro${i}/400/240`,
      };
    } else {
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

function countItemsTraversed(dataset: DatasetKey, traveledDp: number, maxOffset: number): number {
  const {count} = DATASETS[dataset];
  const downDist = Math.min(traveledDp, maxOffset);
  const upDist = Math.min(Math.max(0, traveledDp - maxOffset), maxOffset);
  let total = 0;
  for (let i = 0; i < count; i++) total += datasetHeight(dataset, i);
  let traversed = 0;
  let top = 0;
  for (let i = 0; i < count; i++) {
    const height = datasetHeight(dataset, i);
    if (top < downDist) traversed++;
    if (upDist > 0 && top + height > total - upDist) traversed++;
    top += height;
  }
  return traversed;
}

interface RunReport {
  dataset: DatasetKey;
  mode: RunMode;
  velocityDpPerSec: number;
  durationMs: number;
  jsTicks: number;
  jsAvgTickMs: number;
  jsMaxTickMs: number;
  jsTickP50Ms: number;
  jsTickP95Ms: number;
  jsTickP99Ms: number;
  traveledDp: number;
  itemsTraversed: number;
  mountsPerItem: number | null;
  perf: NitroListPerfSnapshot;
}

interface RunTiming {
  jsAvgTickMs: number;
  jsMaxTickMs: number;
  jsTickP95Ms: number;
  jsTickP99Ms: number;
  traveledDp: number;
  itemsTraversed: number;
}

interface RowCols {
  blankSamples: number;
  blankPxMax: number;
  blankPxSum: number;
  rangeLatAvg: number | null;
  rangeLatMax: number | null;
  jsiPerSec: number;
  batchAvg: number | null;
  batchMax: number | null;
  mounts: number;
  jsTickAvg: number | null;
  jsTickMax: number | null;
  firstRange: number | null;
  stiMs: number | null;
  stiPasses: number | null;
  rangeLatP95: number | null;
  rangeLatP99: number | null;
  jsTickP95: number | null;
  jsTickP99: number | null;
  burstP95: number | null;
  burstMax: number | null;
  distDp: number | null;
  mountsPerItem: number | null;
  rendersPerMount: number | null;
  flingOk: number | null;
  flingMiss: number | null;
  layoutVerPerSec: number;
  orchPerSec: number;
  callbacksPerSec: number;
}

function colsFrom(s: NitroListPerfSnapshot, run?: RunTiming): RowCols {
  return {
    blankSamples: s.blankSamples,
    blankPxMax: s.blankPxMax,
    blankPxSum: s.blankPxSum,
    rangeLatAvg: s.rangeLatencySamples > 0 ? s.rangeLatencySumMs / s.rangeLatencySamples : null,
    rangeLatMax: s.rangeLatencySamples > 0 ? s.rangeLatencyMaxMs : null,
    jsiPerSec: s.windowMs > 0 ? (s.jsiCalls / s.windowMs) * 1000 : 0,
    batchAvg: s.batchFlushes > 0 ? s.batchPairsSum / s.batchFlushes : null,
    batchMax: s.batchFlushes > 0 ? s.batchPairsMax : null,
    mounts: s.itemMounts,
    jsTickAvg: run ? run.jsAvgTickMs : null,
    jsTickMax: run ? run.jsMaxTickMs : null,
    firstRange: s.firstRangeLatencyMs,
    stiMs: s.lastScrollToIndex ? s.lastScrollToIndex.durationMs : null,
    stiPasses: s.lastScrollToIndex ? s.lastScrollToIndex.correctionPasses : null,
    rangeLatP95: s.rangeLatencyTail.count > 0 ? s.rangeLatencyTail.p95 : null,
    rangeLatP99: s.rangeLatencyTail.count > 0 ? s.rangeLatencyTail.p99 : null,
    jsTickP95: run ? run.jsTickP95Ms : null,
    jsTickP99: run ? run.jsTickP99Ms : null,
    burstP95: s.mountBurst.count > 0 ? s.mountBurst.p95 : null,
    burstMax: s.mountBurst.count > 0 ? s.mountBurst.max : null,
    distDp: run ? run.traveledDp : null,
    mountsPerItem: run && run.itemsTraversed > 0 ? s.itemMounts / run.itemsTraversed : null,
    rendersPerMount: s.itemMounts > 0 ? s.itemRenders / s.itemMounts : null,
    flingOk: s.flingPrewarmOutcomes > 0 ? s.flingPrewarmOutcomes - s.flingPrewarmMisses : null,
    flingMiss: s.flingPrewarmOutcomes > 0 ? s.flingPrewarmMisses : null,
    layoutVerPerSec: s.windowMs > 0 ? (s.layoutVersionBumps / s.windowMs) * 1000 : 0,
    orchPerSec: s.windowMs > 0 ? (s.orchestratorRenders / s.windowMs) * 1000 : 0,
    callbacksPerSec: s.windowMs > 0 ? (s.userCallbacks / s.windowMs) * 1000 : 0,
  };
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function medianCols(runs: RowCols[]): RowCols {
  const pick = (read: (c: RowCols) => number | null): number | null => {
    const values: number[] = [];
    for (const run of runs) {
      const value = read(run);
      if (value != null) values.push(value);
    }
    return values.length > 0 ? median(values) : null;
  };
  const req = (read: (c: RowCols) => number): number => median(runs.map(read));
  return {
    blankSamples: req((c) => c.blankSamples),
    blankPxMax: req((c) => c.blankPxMax),
    blankPxSum: req((c) => c.blankPxSum),
    rangeLatAvg: pick((c) => c.rangeLatAvg),
    rangeLatMax: pick((c) => c.rangeLatMax),
    jsiPerSec: req((c) => c.jsiPerSec),
    batchAvg: pick((c) => c.batchAvg),
    batchMax: pick((c) => c.batchMax),
    mounts: req((c) => c.mounts),
    jsTickAvg: pick((c) => c.jsTickAvg),
    jsTickMax: pick((c) => c.jsTickMax),
    firstRange: pick((c) => c.firstRange),
    stiMs: pick((c) => c.stiMs),
    stiPasses: pick((c) => c.stiPasses),
    rangeLatP95: pick((c) => c.rangeLatP95),
    rangeLatP99: pick((c) => c.rangeLatP99),
    jsTickP95: pick((c) => c.jsTickP95),
    jsTickP99: pick((c) => c.jsTickP99),
    burstP95: pick((c) => c.burstP95),
    burstMax: pick((c) => c.burstMax),
    distDp: pick((c) => c.distDp),
    mountsPerItem: pick((c) => c.mountsPerItem),
    rendersPerMount: pick((c) => c.rendersPerMount),
    flingOk: pick((c) => c.flingOk),
    flingMiss: pick((c) => c.flingMiss),
    layoutVerPerSec: req((c) => c.layoutVerPerSec),
    orchPerSec: req((c) => c.orchPerSec),
    callbacksPerSec: req((c) => c.callbacksPerSec),
  };
}

function deviceLabel(): string {
  const build = __DEV__ ? 'dev' : 'rel';
  if (Platform.OS === 'android') {
    const c = Platform.constants as {Model?: string; Brand?: string; Fingerprint?: string};
    const model = c.Model ?? 'android';
    const emulated = /generic|emulator|sdk_gphone|vbox|goldfish/i.test(
      `${model} ${c.Brand ?? ''} ${c.Fingerprint ?? ''}`,
    );
    return `${model} (${emulated ? 'emu' : 'fís.'}, ${build})`;
  }
  return `iOS ${Platform.Version} (${build})`;
}

function renderRow(dataset: DatasetKey, scenario: string, c: RowCols): string {
  const r0 = (n: number | null) => (n == null ? '–' : `${Math.round(n)}`);
  const r1 = (n: number | null) => (n == null ? '–' : `${Math.round(n * 10) / 10}`);
  const r2 = (n: number | null) => (n == null ? '–' : `${Math.round(n * 100) / 100}`);
  const pair = (a: number | null, b: number | null, fmt: (n: number | null) => string) =>
    a == null && b == null ? '–' : `${fmt(a)}/${fmt(b)}`;
  const date = new Date().toISOString().slice(0, 10);
  const blank = `${Math.round(c.blankSamples)}/${r0(c.blankPxMax)}/${r0(c.blankPxSum)}`;
  return (
    `| ${date} | ${deviceLabel()} | ${dataset} | ${scenario} | ${blank} | ` +
    `${pair(c.rangeLatAvg, c.rangeLatMax, r1)} | ${r0(c.jsiPerSec)} | ` +
    `${pair(c.batchAvg, c.batchMax, r1)} | ${r0(c.mounts)} | ` +
    `${pair(c.jsTickAvg, c.jsTickMax, r1)} | ${r0(c.firstRange)} | ` +
    `${pair(c.stiMs, c.stiPasses, r0)} | ${pair(c.rangeLatP95, c.rangeLatP99, r1)} | ` +
    `${pair(c.jsTickP95, c.jsTickP99, r1)} | ${pair(c.burstP95, c.burstMax, r0)} | ` +
    `${r0(c.distDp)} | ${r2(c.mountsPerItem)} | ${r2(c.rendersPerMount)} | ` +
    `${pair(c.flingOk, c.flingMiss, r0)} | ${r1(c.layoutVerPerSec)} | ` +
    `${r1(c.orchPerSec)} | ${r0(c.callbacksPerSec)} |`
  );
}

function toPerfRow(
  dataset: DatasetKey,
  scenario: string,
  s: NitroListPerfSnapshot,
  run?: RunTiming,
): string {
  return renderRow(dataset, scenario, colsFrom(s, run));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowMs(): number {
  const perf = (globalThis as {performance?: {now?: () => number}}).performance;
  return perf != null && typeof perf.now === 'function' ? perf.now() : Date.now();
}

function getFixedItemSize(item: BenchItem): number | undefined {
  return item.kind === 'fixed' ? item.height : undefined;
}

interface MountOptions {
  clearCache?: boolean;
  fixedSizes?: boolean;
  resetBeforeMount?: boolean;
}

export interface NitroListBenchmarkScreenProps {
  headerAccessory?: React.ReactNode;
}

export function NitroListBenchmarkScreen({headerAccessory}: NitroListBenchmarkScreenProps = {}) {
  const [dataset, setDataset] = useState<DatasetKey>('dynamic-1k');
  const [remountKey, setRemountKey] = useState(0);
  const [snapshot, setSnapshot] = useState<NitroListPerfSnapshot | null>(null);
  const [lastReport, setLastReport] = useState<RunReport | null>(null);
  const [running, setRunning] = useState(false);
  const [runMode, setRunMode] = useState<RunMode>('fixed-30s');
  const [lastRow, setLastRow] = useState<string | null>(null);
  const [drawDistance, setDrawDistance] = useState<number>(DRAW_DISTANCE_OPTIONS[0]);
  const [uiThreadScroll, setUiThreadScroll] = useState(false);
  const [driver, setDriver] = useState<ScrollDriver>('scripted');
  const driverRef = useRef(driver);
  driverRef.current = driver;
  const nativeScrollRef = useRef<ScrollView | null>(null);
  const [jsLoadMs, setJsLoadMs] = useState<number>(JS_LOAD_OPTIONS[0]);
  const [fixedSizes, setFixedSizes] = useState(false);
  const [autoFixed, setAutoFixed] = useState(false);
  const [devFlags, setDevFlags] = useState<Record<NitroListDevFlagKey, boolean>>(() => ({
    ...NitroListDevFlags,
  }));
  const [matrixProgress, setMatrixProgress] = useState<string | null>(null);
  const [matrixRows, setMatrixRows] = useState<string[]>([]);

  const disabledFlagsSuffix = NITRO_LIST_DEV_FLAG_KEYS.filter((key) => !devFlags[key])
    .map((key) => ` -${DEV_FLAG_LABELS[key]}`)
    .join('');
  const scenarioBase =
    `@dd${drawDistance}${uiThreadScroll ? ' f4' : ''}${jsLoadMs > 0 ? ` load${jsLoadMs}` : ''}` +
    `${autoFixed ? ' autofix' : ''}${driver === 'finger-like' ? ' finger' : ''}${disabledFlagsSuffix}`;
  const scenarioSuffix = `${scenarioBase}${fixedSizes ? ' fixed' : ''}`;

  const listRef = useRef<NitroListHandle>(null);
  const runAbortRef = useRef(false);
  const runningRef = useRef(false);
  const matrixRunningRef = useRef(false);

  const items = useMemo(() => makeItems(dataset), [dataset]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [chatItems, setChatItems] = useState<BenchItem[] | null>(null);
  const [streaming, setStreaming] = useState(false);
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

  useEffect(() => {
    if (jsLoadMs <= 0) return;
    let cancelled = false;
    let rafId = 0;
    const burn = () => {
      if (cancelled) return;
      const until = nowMs() + jsLoadMs;
      while (nowMs() < until) {}
      rafId = requestAnimationFrame(burn);
    };
    rafId = requestAnimationFrame(burn);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [jsLoadMs]);

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

  const renderScrollComponent = useCallback(
    ({ref, ...rest}: NitroListRenderScrollComponentProps) => {
      const setRef = (node: ScrollView | null) => {
        nativeScrollRef.current = node;
        assignRef(ref, node);
      };
      if (uiThreadScroll) {
        return (
          <Animated.ScrollView
            ref={setRef as unknown as React.ComponentProps<typeof Animated.ScrollView>['ref']}
            style={StyleSheet.absoluteFill}
            {...rest}
          />
        );
      }
      return <ScrollView ref={setRef} style={StyleSheet.absoluteFill} {...rest} />;
    },
    [uiThreadScroll],
  );

  const markRunning = useCallback((value: boolean) => {
    runningRef.current = value;
    setRunning(value);
  }, []);

  const runScrollRun = useCallback(
    (ds: DatasetKey, velocityDpPerSec: number, mode: RunMode, scenario: string) =>
      new Promise<{row: string; report: RunReport} | null>((resolve) => {
        const list = listRef.current;
        if (!list) {
          resolve(null);
          return;
        }
        markRunning(true);
        runAbortRef.current = false;
        NitroListPerfMonitor.reset();

        const viewportH = list.getWindowSize().height;
        const startedAt = Date.now();
        let offset = 0;
        let direction: 1 | -1 = 1;
        let lastTick = Date.now();
        let ticks = 0;
        let maxGap = 0;
        let traveled = 0;
        let lastMaxOffset = 0;
        const tickGaps = new LatencyDistribution();

        list.scrollToOffset({offset: 0, animated: false});

        const finish = () => {
          const durationMs = Date.now() - startedAt;
          const gapTail = tickGaps.snapshot();
          const perf = NitroListPerfMonitor.getSnapshot();
          const itemsTraversed = countItemsTraversed(ds, traveled, lastMaxOffset);
          const report: RunReport = {
            dataset: ds,
            mode,
            velocityDpPerSec,
            durationMs,
            jsTicks: ticks,
            jsAvgTickMs: ticks > 0 ? Math.round((durationMs / ticks) * 10) / 10 : 0,
            jsMaxTickMs: Math.round(maxGap * 10) / 10,
            jsTickP50Ms: Math.round(gapTail.p50 * 10) / 10,
            jsTickP95Ms: Math.round(gapTail.p95 * 10) / 10,
            jsTickP99Ms: Math.round(gapTail.p99 * 10) / 10,
            traveledDp: Math.round(traveled),
            itemsTraversed,
            mountsPerItem:
              itemsTraversed > 0 ? Math.round((perf.itemMounts / itemsTraversed) * 100) / 100 : null,
            perf,
          };
          setLastReport(report);
          markRunning(false);
          const row = toPerfRow(ds, scenario, report.perf, report);
          setLastRow(row);
          resolve({row, report});
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
          const dt = Math.min(now - lastTick, 64);
          if (now !== lastTick) {
            maxGap = Math.max(maxGap, now - lastTick);
            tickGaps.record(now - lastTick);
          }
          lastTick = now;
          ticks++;
          const prevOffset = offset;
          offset += (direction * (velocityDpPerSec * dt)) / 1000;
          const maxOffset = Math.max(0, listRef.current.getTotalSize() - viewportH);
          lastMaxOffset = maxOffset;
          let reachedStart = false;
          if (direction === 1 && offset >= maxOffset) {
            offset = maxOffset;
            direction = -1;
          } else if (direction === -1 && offset <= 0) {
            offset = 0;
            reachedStart = true;
          }
          traveled += Math.abs(offset - prevOffset);
          const rawScrollView = driverRef.current === 'finger-like' ? nativeScrollRef.current : null;
          if (rawScrollView != null) {
            rawScrollView.scrollTo({y: offset, animated: false});
          } else {
            listRef.current.scrollToOffset({offset, animated: false});
          }
          if (reachedStart) {
            finish();
            return;
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    [markRunning],
  );

  const runStiRun = useCallback(
    async (
      ds: DatasetKey,
      scenario: string,
    ): Promise<{row: string; snapshot: NitroListPerfSnapshot} | null> => {
      const list = listRef.current;
      if (!list) return null;
      if (list.getAbsoluteLastScrollOffset() > 0) {
        list.scrollToOffset({offset: 0, animated: false});
        await delay(STI_REPOSITION_SETTLE_MS);
      }
      NitroListPerfMonitor.reset();
      const target = stiTargetIndex(ds);
      await list.scrollToIndex({index: target, animated: false, viewPosition: 0.5}).catch(() => {});
      const snap = NitroListPerfMonitor.getSnapshot();
      setSnapshot(snap);
      const row = toPerfRow(ds, scenario, snap);
      setLastRow(row);
      return {row, snapshot: snap};
    },
    [],
  );

  const runStreamRun = useCallback(
    (ds: DatasetKey, scenario: string) =>
      new Promise<{row: string; report: RunReport} | null>((resolve) => {
        const list = listRef.current;
        if (!list) {
          resolve(null);
          return;
        }
        markRunning(true);
        runAbortRef.current = false;
        setChatItems(itemsRef.current.slice());
        setStreaming(true);
        void list.scrollToEnd(false);
        NitroListPerfMonitor.reset();

        const startedAt = Date.now();
        let lastTick = startedAt;
        let ticks = 0;
        let maxGap = 0;
        let token = 0;
        const tickGaps = new LatencyDistribution();
        const interval = setInterval(() => {
          token++;
          const grow = token % 8 === 0 ? 20 : 0;
          setChatItems((prev) => {
            if (prev == null) return prev;
            const next = prev.slice();
            const lastIndex = next.length - 1;
            const last = next[lastIndex];
            next[lastIndex] = {
              ...last,
              text: `${last.text} tok${token}`,
              height: last.height + grow,
            };
            return next;
          });
        }, STREAM_INTERVAL_MS);

        const finish = () => {
          clearInterval(interval);
          const durationMs = Date.now() - startedAt;
          const gapTail = tickGaps.snapshot();
          const perf = NitroListPerfMonitor.getSnapshot();
          const report: RunReport = {
            dataset: ds,
            mode: 'fixed-30s',
            velocityDpPerSec: 0,
            durationMs,
            jsTicks: ticks,
            jsAvgTickMs: ticks > 0 ? Math.round((durationMs / ticks) * 10) / 10 : 0,
            jsMaxTickMs: Math.round(maxGap * 10) / 10,
            jsTickP50Ms: Math.round(gapTail.p50 * 10) / 10,
            jsTickP95Ms: Math.round(gapTail.p95 * 10) / 10,
            jsTickP99Ms: Math.round(gapTail.p99 * 10) / 10,
            traveledDp: 0,
            itemsTraversed: 0,
            mountsPerItem: null,
            perf,
          };
          setLastReport(report);
          setSnapshot(perf);
          setStreaming(false);
          markRunning(false);
          const row = toPerfRow(ds, scenario, perf, report);
          setLastRow(row);
          resolve({row, report});
        };

        const step = () => {
          if (runAbortRef.current || !listRef.current) {
            finish();
            return;
          }
          const now = Date.now();
          if (now - startedAt >= FIXED_RUN_DURATION_MS) {
            finish();
            return;
          }
          if (now !== lastTick) {
            maxGap = Math.max(maxGap, now - lastTick);
            tickGaps.record(now - lastTick);
          }
          lastTick = now;
          ticks++;
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    [markRunning],
  );

  const runStreamTest = useCallback(() => {
    if (runningRef.current || matrixRunningRef.current) return;
    void runStreamRun(dataset, `chat-stream 20Hz 30s ${scenarioSuffix}`).then((result) => {
      if (!result) return;
      benchLog('[NitroListBenchmark]', JSON.stringify(result.report, null, 2));
      benchLog('[NitroListBenchmark] results row:\n' + result.row);
    });
  }, [dataset, runStreamRun, scenarioSuffix]);

  const runScrollTest = useCallback(
    (velocityDpPerSec: number) => {
      if (runningRef.current || matrixRunningRef.current) return;
      const scenario = `${velocityDpPerSec / 1000}k dp/s ${
        runMode === 'fixed-30s' ? '30s' : 'sweep'
      } ${scenarioSuffix}`;
      void runScrollRun(dataset, velocityDpPerSec, runMode, scenario).then((result) => {
        if (!result) return;
        benchLog('[NitroListBenchmark]', JSON.stringify(result.report, null, 2));
        benchLog('[NitroListBenchmark] results row:\n' + result.row);
      });
    },
    [dataset, runMode, runScrollRun, scenarioSuffix],
  );

  const runScrollToIndexTest = useCallback(() => {
    if (runningRef.current || matrixRunningRef.current) return;
    void runStiRun(dataset, `scrollToIndex ${scenarioSuffix}`).then((result) => {
      if (!result) return;
      benchLog('[NitroListBenchmark] results row:\n' + result.row);
      logStiPhases(result.snapshot);
    });
  }, [dataset, runStiRun, scenarioSuffix]);

  const stop = useCallback(() => {
    runAbortRef.current = true;
  }, []);

  const remount = useCallback(() => {
    if (runningRef.current || matrixRunningRef.current) return;
    NitroListPerfMonitor.reset();
    setRemountKey((k) => k + 1);
  }, []);

  const applyConfig = useCallback((change: () => void) => {
    if (runningRef.current || matrixRunningRef.current) return;
    change();
    NitroListPerfMonitor.reset();
    setRemountKey((k) => k + 1);
  }, []);

  const toggleDevFlag = useCallback(
    (key: NitroListDevFlagKey) => {
      applyConfig(() => {
        NitroListDevFlags[key] = !NitroListDevFlags[key];
        setDevFlags({...NitroListDevFlags});
      });
    },
    [applyConfig],
  );

  const mountDataset = useCallback(async (ds: DatasetKey, options: MountOptions = {}) => {
    if (options.clearCache) clearMeasurementCache();
    setFixedSizes(options.fixedSizes === true);
    if (options.resetBeforeMount) NitroListPerfMonitor.reset();
    setDataset(ds);
    setChatItems(null);
    setRemountKey((k) => k + 1);
    const deadline = Date.now() + LIST_READY_TIMEOUT_MS;
    for (;;) {
      await delay(100);
      const list = listRef.current;
      if (list != null && list.getTotalSize() > 0) {
        if (!options.resetBeforeMount || NitroListPerfMonitor.getSnapshot().firstRangeLatencyMs != null) {
          break;
        }
      }
      if (Date.now() > deadline) break;
    }
    await delay(ds === 'images-500' ? MATRIX_IMAGE_SETTLE_MS : MATRIX_SETTLE_MS);
  }, []);

  const runMatrix = useCallback(async () => {
    if (runningRef.current || matrixRunningRef.current) return;
    matrixRunningRef.current = true;
    runAbortRef.current = false;
    setMatrixRows([]);
    const medians: string[] = [];
    const allRows: string[] = [];

    for (let cellIdx = 0; cellIdx < MATRIX.length; cellIdx++) {
      const cell = MATRIX[cellIdx];
      const cellSuffix = cell.suffix != null ? ` ${cell.suffix}` : '';
      const scenario =
        cell.kind === 'sti'
          ? `scrollToIndex ${scenarioBase}${cellSuffix}`
          : cell.kind === 'mount'
            ? `mount ${scenarioBase}${cellSuffix}`
            : cell.kind === 'stream'
              ? `chat-stream 20Hz 30s ${scenarioBase}${cellSuffix}`
              : `${(cell.velocityDpPerSec ?? 0) / 1000}k dp/s 30s ${scenarioBase}${cellSuffix}`;
      const cols: RowCols[] = [];

      for (let rep = 0; rep < MATRIX_REPS; rep++) {
        if (runAbortRef.current) break;
        setMatrixProgress(
          `matriz ${cellIdx + 1}/${MATRIX.length} · #${cell.id} ${cell.dataset} · run ${rep + 1}/${MATRIX_REPS}`,
        );
        await mountDataset(cell.dataset, {
          clearCache: cell.coldCache === true,
          fixedSizes: cell.fixedSizes === true,
          resetBeforeMount: cell.kind === 'mount',
        });
        if (runAbortRef.current) break;
        if (cell.kind === 'mount') {
          const snap = NitroListPerfMonitor.getSnapshot();
          setSnapshot(snap);
          const row = toPerfRow(cell.dataset, scenario, snap);
          setLastRow(row);
          allRows.push(row);
          cols.push(colsFrom(snap));
        } else if (cell.kind === 'sti') {
          const result = await runStiRun(cell.dataset, scenario);
          if (result) {
            allRows.push(result.row);
            cols.push(colsFrom(result.snapshot));
            logStiPhases(result.snapshot);
          }
        } else if (cell.kind === 'stream') {
          const result = await runStreamRun(cell.dataset, scenario);
          if (result) {
            allRows.push(result.row);
            cols.push(colsFrom(result.report.perf, result.report));
          }
        } else {
          const result = await runScrollRun(
            cell.dataset,
            cell.velocityDpPerSec ?? 0,
            'fixed-30s',
            scenario,
          );
          if (result) {
            allRows.push(result.row);
            cols.push(colsFrom(result.report.perf, result.report));
          }
        }
        await delay(MATRIX_COOLDOWN_MS);
      }

      if (cols.length > 0) {
        const row = renderRow(cell.dataset, scenario, medianCols(cols));
        medians.push(row);
        setMatrixRows(medians.slice());
      }
      if (runAbortRef.current) break;
    }

    setFixedSizes(false);
    matrixRunningRef.current = false;
    setMatrixProgress(runAbortRef.current ? 'matriz abortada (parcial)' : null);
    benchLog(
      `[NitroListBenchmark] matrix runs (${MATRIX_REPS}x por célula):\n` + allRows.join('\n'),
    );
    benchLog('[NitroListBenchmark] matrix median rows:\n' + medians.join('\n'));
  }, [mountDataset, runScrollRun, runStiRun, runStreamRun, scenarioBase]);

  const dump = useCallback(() => {
    const snap = NitroListPerfMonitor.getSnapshot();
    setSnapshot(snap);
    const payload = {dataset, snapshot: snap, lastReport};
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
  const rendersPerMount =
    s && s.itemMounts > 0 ? Math.round((s.itemRenders / s.itemMounts) * 100) / 100 : null;

  return (
    <View style={styles.container}>
      <View style={styles.controls}>
        {headerAccessory}
        <View style={styles.buttonRow}>
          {(Object.keys(DATASETS) as DatasetKey[]).map((key) => (
            <Pressable
              key={key}
              onPress={() => applyConfig(() => setDataset(key))}
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
          {running || matrixProgress != null ? (
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
              onPress={() => applyConfig(() => setDrawDistance(dd))}
              style={[styles.button, drawDistance === dd && styles.buttonActive]}>
              <Text style={styles.buttonText}>dd{dd}</Text>
            </Pressable>
          ))}
          <Pressable
            onPress={() => applyConfig(() => setUiThreadScroll((v) => !v))}
            style={[styles.button, uiThreadScroll && styles.buttonActive]}>
            <Text style={styles.buttonText}>F4: {uiThreadScroll ? 'on' : 'off'}</Text>
          </Pressable>
          <Pressable
            onPress={() =>
              applyConfig(() => setDriver((v) => (v === 'scripted' ? 'finger-like' : 'scripted')))
            }
            style={[styles.button, driver === 'finger-like' && styles.buttonActive]}>
            <Text style={styles.buttonText}>driver: {driver === 'finger-like' ? 'finger' : 'scripted'}</Text>
          </Pressable>
          <Pressable onPress={runStreamTest} style={styles.button}>
            <Text style={styles.buttonText}>chat-stream</Text>
          </Pressable>
          <Pressable
            onPress={() =>
              applyConfig(() =>
                setJsLoadMs((v) => {
                  const idx = JS_LOAD_OPTIONS.indexOf(v as (typeof JS_LOAD_OPTIONS)[number]);
                  return JS_LOAD_OPTIONS[(idx + 1) % JS_LOAD_OPTIONS.length];
                }),
              )
            }
            style={[styles.button, jsLoadMs > 0 && styles.buttonActive]}>
            <Text style={styles.buttonText}>load: {jsLoadMs}ms</Text>
          </Pressable>
          <Pressable
            onPress={() => applyConfig(() => setFixedSizes((v) => !v))}
            style={[styles.button, fixedSizes && styles.buttonActive]}>
            <Text style={styles.buttonText}>fixed: {fixedSizes ? 'on' : 'off'}</Text>
          </Pressable>
          <Pressable
            onPress={() => applyConfig(() => setAutoFixed((v) => !v))}
            style={[styles.button, autoFixed && styles.buttonActive]}>
            <Text style={styles.buttonText}>autoFix: {autoFixed ? 'on' : 'off'}</Text>
          </Pressable>
          <Pressable
            onPress={() => void runMatrix()}
            style={[styles.button, styles.buttonMatrix]}>
            <Text style={styles.buttonText}>Run matrix (~15min)</Text>
          </Pressable>
        </View>
        <View style={styles.buttonRow}>
          {NITRO_LIST_DEV_FLAG_KEYS.map((key) => (
            <Pressable
              key={key}
              onPress={() => toggleDevFlag(key)}
              style={[styles.button, styles.buttonFlag, devFlags[key] && styles.buttonActive]}>
              <Text style={styles.buttonText}>{DEV_FLAG_LABELS[key]}</Text>
            </Pressable>
          ))}
        </View>
        {matrixProgress != null ? (
          <Text style={styles.progress}>{matrixProgress}</Text>
        ) : null}
        {s ? (
          <Text style={styles.stats}>
            blank: {s.blankSamples}/{s.scrollSamples} samples · max {Math.round(s.blankPxMax)}dp ·
            Σ{Math.round(s.blankPxSum)}dp{'\n'}
            batches: {s.batchFlushes} (avg {avgBatch}, max {s.batchPairsMax} pairs) · ranges:{' '}
            {s.rangeEvents} · layoutVer: {s.layoutVersionBumps}
            {'\n'}
            mounts: {s.itemMounts} · unmounts: {s.itemUnmounts} · renders: {s.itemRenders} (
            {rendersPerMount ?? '–'}/mount)
            {'\n'}
            firstRange: {s.firstRangeLatencyMs ?? '–'}ms · STI:{' '}
            {s.lastScrollToIndex
              ? `${s.lastScrollToIndex.durationMs}ms/${s.lastScrollToIndex.correctionPasses}p/${s.lastScrollToIndex.prewarmRestarts}r`
              : '–'}{' '}
            · fling: {s.flingPrewarmOutcomes - s.flingPrewarmMisses}/{s.flingPrewarmOutcomes} hit
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
              ? `\nrun: ${lastReport.velocityDpPerSec}dp/s · jsTick avg ${lastReport.jsAvgTickMs} p95 ${lastReport.jsTickP95Ms} p99 ${lastReport.jsTickP99Ms} max ${lastReport.jsMaxTickMs}ms · dist ${lastReport.traveledDp}dp · ${lastReport.itemsTraversed} items · ${lastReport.mountsPerItem ?? '–'} mounts/item`
              : ''}
          </Text>
        ) : null}
        {matrixRows.length > 0 ? (
          <ScrollView style={styles.rowsBox}>
            <Text selectable style={styles.rowOutput}>
              {matrixRows.join('\n')}
            </Text>
          </ScrollView>
        ) : lastRow != null ? (
          <Text selectable style={styles.rowOutput}>
            {lastRow}
          </Text>
        ) : null}
      </View>
      <View style={styles.listWrapper}>
        <NitroList<BenchItem>
          key={`${dataset}-${remountKey}`}
          ref={listRef}
          data={chatItems ?? items}
          maintainScrollAtEnd={streaming}
          anchoredEndSpace={
            streaming && chatItems != null ? {anchorIndex: chatItems.length - 1} : undefined
          }
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          getItemType={getItemType}
          getFixedItemSize={fixedSizes ? getFixedItemSize : undefined}
          autoFixedItemSizes={autoFixed}
          estimatedItemSize={estimatedItemSize}
          drawDistance={drawDistance}
          experimentalUiThreadScroll={uiThreadScroll}
          renderScrollComponent={renderScrollComponent}
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
  buttonFlag: {
    backgroundColor: '#5a3a3c',
  },
  buttonActive: {
    backgroundColor: '#0a84ff',
  },
  buttonStop: {
    backgroundColor: '#ff453a',
  },
  buttonMatrix: {
    backgroundColor: '#30d158',
  },
  buttonText: {
    color: '#fff',
    fontSize: 12,
  },
  progress: {
    color: '#30d158',
    fontSize: 11,
    marginBottom: 4,
  },
  stats: {
    color: '#7dff9b',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  rowsBox: {
    maxHeight: 150,
    marginTop: 4,
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
