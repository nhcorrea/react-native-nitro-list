import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  NitroList,
  NitroListPerfMonitor,
  type NitroListHandle,
  type NitroListOnViewableItemsChanged,
  type NitroListPerfSnapshot,
  type NitroListRenderItem,
} from '@nhcorrea/react-native-nitro-list';

import {
  NITRO_LIST_PERF_COMPILED,
  NitroListBenchmarkScreen,
} from '@nhcorrea/react-native-nitro-list/dev';

import QAFixturesScreen from './QAFixturesScreen';

type RowKind = 'plain' | 'text' | 'image' | 'gallery' | 'card' | 'header';

type StressItem = {
  id: string;
  kind: RowKind;
  title: string;
  body: string;
  imageUris: string[];
  imageHeight: number;
};

type ScenarioKey =
  | 'plain-100k'
  | 'dynamic-50k'
  | 'media-10k'
  | 'sections-25k'
  | 'feed-5k';

const SCENARIOS: Record<
  ScenarioKey,
  { label: string; count: number; estimatedItemSize: number }
> = {
  'plain-100k': { label: '100k plain', count: 100_000, estimatedItemSize: 64 },
  'dynamic-50k': { label: '50k dyn', count: 50_000, estimatedItemSize: 96 },
  'media-10k': { label: '10k media', count: 10_000, estimatedItemSize: 150 },
  'sections-25k': { label: '25k sticky', count: 25_000, estimatedItemSize: 72 },
  'feed-5k': { label: '5k feed', count: 5_000, estimatedItemSize: 340 },
};

const SCENARIO_KEYS = Object.keys(SCENARIOS) as ScenarioKey[];

const TORTURE_INTERVAL_MS = 900;
const CHURN_INTERVAL_MS = 700;
const SECTION_EVERY = 25;

type AutoScrollDirection = -1 | 0 | 1;
const AUTO_SCROLL_VELOCITIES = [1500, 3000, 6000, 10000] as const;

const LOREM =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation'.split(
    ' '
  );

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sentence(rand: () => number, words: number): string {
  const out: string[] = new Array(words);
  for (let i = 0; i < words; i++) {
    out[i] = LOREM[Math.floor(rand() * LOREM.length)];
  }
  return out.join(' ');
}

function picsum(seed: string, w: number, h: number): string {
  return `https://picsum.photos/seed/${seed}/${w}/${h}`;
}

function kindForOrdinal(scenario: ScenarioKey, ordinal: number, rand: () => number): RowKind {
  switch (scenario) {
    case 'plain-100k':
      return 'plain';
    case 'dynamic-50k':
      return 'text';
    case 'feed-5k':
      return 'card';
    case 'sections-25k': {
      if (ordinal % SECTION_EVERY === 0) return 'header';
      const r = rand();
      if (r < 0.6) return 'plain';
      if (r < 0.9) return 'text';
      return 'image';
    }
    case 'media-10k': {
      const r = rand();
      if (r < 0.3) return 'plain';
      if (r < 0.55) return 'text';
      if (r < 0.75) return 'image';
      if (r < 0.9) return 'gallery';
      return 'card';
    }
  }
}

function createItem(
  scenario: ScenarioKey,
  ordinal: number,
  serialRef: { current: number }
): StressItem {
  const serial = serialRef.current++;
  const rand = mulberry32(serial * 2654435761 + ordinal);
  const kind = kindForOrdinal(scenario, ordinal, rand);
  const id = `s${serial}`;
  const imageHeight = 140 + Math.floor(rand() * 160);

  switch (kind) {
    case 'header':
      return {
        id,
        kind,
        title: `Section ${Math.floor(ordinal / SECTION_EVERY)}`,
        body: '',
        imageUris: [],
        imageHeight: 0,
      };
    case 'plain':
      return {
        id,
        kind,
        title: `Row #${serial}`,
        body: sentence(rand, 4 + Math.floor(rand() * 4)),
        imageUris: [],
        imageHeight: 0,
      };
    case 'text':
      return {
        id,
        kind,
        title: `Dynamic #${serial}`,
        body: sentence(rand, 6 + Math.floor(rand() * 44)),
        imageUris: [],
        imageHeight: 0,
      };
    case 'image':
      return {
        id,
        kind,
        title: `Photo #${serial}`,
        body: sentence(rand, 5 + Math.floor(rand() * 8)),
        imageUris: [picsum(`hero${serial}`, 600, 360)],
        imageHeight,
      };
    case 'gallery': {
      const thumbs = 3 + Math.floor(rand() * 3);
      const uris: string[] = new Array(thumbs);
      for (let t = 0; t < thumbs; t++) {
        uris[t] = picsum(`thumb${serial}-${t}`, 160, 160);
      }
      return {
        id,
        kind,
        title: `Gallery #${serial}`,
        body: sentence(rand, 4 + Math.floor(rand() * 6)),
        imageUris: uris,
        imageHeight: 72,
      };
    }
    case 'card':
      return {
        id,
        kind,
        title: `User ${serial % 997}`,
        body: sentence(rand, 12 + Math.floor(rand() * 36)),
        imageUris: [picsum(`avatar${serial % 97}`, 80, 80), picsum(`card${serial}`, 600, 400)],
        imageHeight: 180 + Math.floor(rand() * 140),
      };
  }
}

type ListData = {
  scenario: ScenarioKey;
  items: StressItem[];
  version: number;
};

function buildDataset(scenario: ScenarioKey, serialRef: { current: number }): ListData {
  const { count } = SCENARIOS[scenario];
  const items: StressItem[] = new Array(count);
  for (let i = 0; i < count; i++) {
    items[i] = createItem(scenario, i, serialRef);
  }
  return { scenario, items, version: 0 };
}

function churnStep(prev: ListData, serialRef: { current: number }): ListData {
  const r = Math.random();
  if (r < 0.35) {
    const appended = prev.items.slice();
    const base = appended.length;
    for (let i = 0; i < 60; i++) {
      appended.push(createItem(prev.scenario, base + i, serialRef));
    }
    return { ...prev, items: appended };
  }
  if (r < 0.55) {
    const fresh: StressItem[] = new Array(15);
    for (let i = 0; i < 15; i++) {
      fresh[i] = createItem(prev.scenario, i, serialRef);
    }
    return { ...prev, items: fresh.concat(prev.items) };
  }
  if (r < 0.8) {
    const updated = prev.items.slice();
    for (let i = 0; i < 40; i++) {
      const idx = Math.floor(Math.random() * updated.length);
      const it = updated[idx];
      if (it.kind === 'header') continue;
      updated[idx] = { ...it, title: `${it.title.split(' ·')[0]} · v${Date.now() % 1000}` };
    }
    return { ...prev, items: updated };
  }
  if (prev.items.length <= 100) return prev;
  const start = Math.floor(Math.random() * (prev.items.length - 30));
  const removed = prev.items.slice();
  removed.splice(start, 30);
  return { ...prev, items: removed };
}

function rerollItem(item: StressItem, serial: number): StressItem {
  if (item.kind === 'header') return item;
  const rand = mulberry32(serial ^ 0x9e3779b9);
  const next: StressItem = { ...item, imageHeight: 140 + Math.floor(rand() * 160) };
  if (item.kind === 'text' || item.kind === 'card') {
    next.body = sentence(rand, 6 + Math.floor(rand() * 44));
  }
  return next;
}

type RowProps = {
  item: StressItem;
  selected: boolean;
  isSticky: boolean;
  onPress: (id: string) => void;
};

const Row = React.memo(function Row({ item, selected, isSticky, onPress }: RowProps) {
  const press = () => onPress(item.id);
  switch (item.kind) {
    case 'header':
      return (
        <View style={[styles.sectionHeader, isSticky && styles.sectionHeaderSticky]}>
          <Text style={styles.sectionTitle}>{item.title}</Text>
        </View>
      );
    case 'plain':
      return (
        <Pressable onPress={press} style={[styles.row, selected && styles.rowSelected]}>
          <Text style={styles.title}>{item.title}</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {item.body}
          </Text>
        </Pressable>
      );
    case 'text':
      return (
        <Pressable onPress={press} style={[styles.row, selected && styles.rowSelected]}>
          <Text style={styles.title}>{item.title}</Text>
          <Text style={styles.subtitle}>{item.body}</Text>
        </Pressable>
      );
    case 'image':
      return (
        <Pressable onPress={press} style={[styles.mediaRow, selected && styles.rowSelected]}>
          <Text style={styles.title}>{item.title}</Text>
          <Image
            source={{ uri: item.imageUris[0] }}
            style={[styles.hero, { height: item.imageHeight }]}
            resizeMode="cover"
          />
          <Text style={styles.subtitle}>{item.body}</Text>
        </Pressable>
      );
    case 'gallery':
      return (
        <Pressable onPress={press} style={[styles.mediaRow, selected && styles.rowSelected]}>
          <Text style={styles.title}>{item.title}</Text>
          <View style={styles.thumbRow}>
            {item.imageUris.map(uri => (
              <Image key={uri} source={{ uri }} style={styles.thumb} resizeMode="cover" />
            ))}
          </View>
          <Text style={styles.subtitle} numberOfLines={1}>
            {item.body}
          </Text>
        </Pressable>
      );
    case 'card':
      return (
        <Pressable onPress={press} style={[styles.card, selected && styles.rowSelected]}>
          <View style={styles.cardHeader}>
            <Image source={{ uri: item.imageUris[0] }} style={styles.avatar} />
            <View style={styles.cardHeaderText}>
              <Text style={styles.title}>{item.title}</Text>
              <Text style={styles.subtitle}>just now</Text>
            </View>
          </View>
          <Text style={styles.cardBody}>{item.body}</Text>
          <Image
            source={{ uri: item.imageUris[1] }}
            style={[styles.hero, { height: item.imageHeight }]}
            resizeMode="cover"
          />
          <View style={styles.cardActions}>
            <Text style={styles.cardAction}>Like</Text>
            <Text style={styles.cardAction}>Comment</Text>
            <Text style={styles.cardAction}>Share</Text>
          </View>
        </Pressable>
      );
  }
});

type ChipTone = 'scroll' | 'list' | 'debug';

const CHIP_TONES: Record<ChipTone, { bg: string; bgActive: string; label: string }> = {
  scroll: { bg: '#dbeafe', bgActive: '#1d4ed8', label: '#1e40af' },
  list: { bg: '#d1fae5', bgActive: '#047857', label: '#065f46' },
  debug: { bg: '#fef3c7', bgActive: '#b45309', label: '#92400e' },
};

function Chip({
  label,
  active,
  tone,
  onPress,
}: {
  label: string;
  active: boolean;
  tone: ChipTone;
  onPress: () => void;
}) {
  const colors = CHIP_TONES[tone];
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, { backgroundColor: active ? colors.bgActive : colors.bg }]}
    >
      <Text style={[styles.chipLabel, { color: active ? '#fff' : colors.label }]}>{label}</Text>
    </Pressable>
  );
}

const ListHeader = () => <Text style={styles.listEdge}>— list header —</Text>;
const ListFooter = () => <Text style={styles.listEdge}>— list footer —</Text>;
const Separator = () => <View style={styles.separator} />;

type ScreenKey = 'bench' | 'stress' | 'qa';

const SCREEN_TABS: { key: ScreenKey; label: string }[] = [
  { key: 'bench', label: 'Bench' },
  { key: 'stress', label: 'Stress lab' },
  { key: 'qa', label: 'QA' },
];

function ScreenTabs({
  screen,
  onSelect,
}: {
  screen: ScreenKey;
  onSelect: (key: ScreenKey) => void;
}): React.JSX.Element {
  return (
    <View style={styles.tabRow}>
      {SCREEN_TABS.filter(tab => tab.key !== 'bench' || NITRO_LIST_PERF_COMPILED).map(tab => (
        <Pressable
          key={tab.key}
          onPress={() => onSelect(tab.key)}
          style={[styles.tab, screen === tab.key && styles.tabActive]}
        >
          <Text style={styles.tabLabel}>{tab.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function App(): React.JSX.Element {
  // Bancada primeiro: o APK existe para rodar a matriz do docs/PERF.md.
  const [screen, setScreen] = useState<ScreenKey>(
    NITRO_LIST_PERF_COMPILED ? 'bench' : 'stress'
  );
  if (screen === 'qa') {
    return <QAFixturesScreen onExit={() => setScreen('stress')} />;
  }
  if (screen === 'bench') {
    return (
      <NitroListBenchmarkScreen
        headerAccessory={<ScreenTabs screen={screen} onSelect={setScreen} />}
      />
    );
  }
  return (
    <StressLab
      onOpenQA={() => setScreen('qa')}
      onOpenBench={() => setScreen('bench')}
    />
  );
}

function StressLab({
  onOpenQA,
  onOpenBench,
}: {
  onOpenQA: () => void;
  onOpenBench: () => void;
}): React.JSX.Element {
  const serialRef = useRef({ current: 0 });
  const [dataState, setDataState] = useState<ListData>(() =>
    buildDataset('plain-100k', serialRef.current)
  );
  const [pressedId, setPressedId] = useState<string | null>(null);
  const [torture, setTorture] = useState(false);
  const [autoScroll, setAutoScroll] = useState<AutoScrollDirection>(0);
  const [velocityIdx, setVelocityIdx] = useState(1);
  const [churn, setChurn] = useState(false);
  const [uiScroll, setUiScroll] = useState(false);
  const [hud, setHud] = useState(true);
  const [snapshot, setSnapshot] = useState<NitroListPerfSnapshot | null>(null);
  const [fps, setFps] = useState(0);
  const [visibleWindow, setVisibleWindow] = useState<[number, number] | null>(null);
  const [edgeHits, setEdgeHits] = useState({ end: 0, start: 0 });

  const listRef = useRef<NitroListHandle>(null);
  const itemsRef = useRef(dataState.items);
  itemsRef.current = dataState.items;

  const scenario = dataState.scenario;
  const { estimatedItemSize } = SCENARIOS[scenario];

  const stickyIndices = useMemo(() => {
    if (scenario !== 'sections-25k') return undefined;
    const idx: number[] = [];
    for (let i = 0; i < dataState.items.length; i++) {
      if (dataState.items[i].kind === 'header') idx.push(i);
    }
    return idx;
  }, [scenario, dataState.items]);

  const selectScenario = useCallback((key: ScenarioKey) => {
    setPressedId(null);
    setVisibleWindow(null);
    setEdgeHits({ end: 0, start: 0 });
    setDataState(buildDataset(key, serialRef.current));
    NitroListPerfMonitor.reset();
  }, []);

  const shuffle = useCallback(() => {
    setDataState(prev => {
      const items = prev.items.slice();
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = items[i];
        items[i] = items[j];
        items[j] = tmp;
      }
      return { ...prev, items };
    });
  }, []);

  const reroll = useCallback(() => {
    setDataState(prev => ({
      ...prev,
      items: prev.items.map(rerollItem),
      version: prev.version + 1,
    }));
  }, []);

  const jumpRandom = useCallback(() => {
    const count = itemsRef.current.length;
    if (count === 0) return;
    const index = Math.floor(Math.random() * count);
    listRef.current?.scrollToIndex({ index, animated: true }).catch(() => {});
  }, []);

  const toggleAutoScroll = useCallback((direction: 1 | -1) => {
    setTorture(false);
    setAutoScroll(prev => (prev === direction ? 0 : direction));
  }, []);

  const toggleTorture = useCallback(() => {
    setAutoScroll(0);
    setTorture(v => !v);
  }, []);

  const velocity = AUTO_SCROLL_VELOCITIES[velocityIdx];
  const cycleVelocity = useCallback(() => {
    setVelocityIdx(i => (i + 1) % AUTO_SCROLL_VELOCITIES.length);
  }, []);

  useEffect(() => {
    if (autoScroll === 0) return;
    let rafId = 0;
    let last = Date.now();
    const tick = () => {
      const list = listRef.current;
      if (!list) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      const now = Date.now();
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const max = Math.max(0, list.getTotalSize() - list.getWindowSize().height);
      if (max <= 0) {
        setAutoScroll(0);
        return;
      }
      const next = list.getAbsoluteLastScrollOffset() + autoScroll * velocity * dt;
      if (next <= 0 || next >= max) {
        list.scrollToOffset({ offset: Math.min(Math.max(next, 0), max), animated: false });
        setAutoScroll(autoScroll === 1 ? -1 : 1);
        return;
      }
      list.scrollToOffset({ offset: next, animated: false });
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [autoScroll, velocity]);

  useEffect(() => {
    if (!torture) return;
    const id = setInterval(() => {
      const list = listRef.current;
      const count = itemsRef.current.length;
      if (!list || count === 0) return;
      const r = Math.random();
      if (r < 0.35) {
        list
          .scrollToIndex({ index: Math.floor(Math.random() * count), animated: true })
          .catch(() => {});
      } else if (r < 0.6) {
        list
          .scrollToIndex({ index: Math.floor(Math.random() * count), animated: false })
          .catch(() => {});
      } else if (r < 0.8) {
        list.scrollToOffset({
          offset: Math.random() * list.getTotalSize(),
          animated: false,
        });
      } else if (r < 0.9) {
        list.scrollToEnd(true);
      } else {
        list.scrollToIndex({ index: 0, animated: true }).catch(() => {});
      }
    }, TORTURE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [torture]);

  useEffect(() => {
    if (!churn) return;
    const id = setInterval(() => {
      setDataState(prev => churnStep(prev, serialRef.current));
    }, CHURN_INTERVAL_MS);
    return () => clearInterval(id);
  }, [churn]);

  useEffect(() => {
    if (!hud) return;
    NitroListPerfMonitor.enable();
    const id = setInterval(() => {
      setSnapshot(NitroListPerfMonitor.getSnapshot());
    }, 1000);
    return () => {
      clearInterval(id);
      NitroListPerfMonitor.disable();
      setSnapshot(null);
    };
  }, [hud]);

  useEffect(() => {
    if (!hud) return;
    let rafId = 0;
    let frames = 0;
    let last = Date.now();
    const loop = () => {
      frames++;
      const now = Date.now();
      if (now - last >= 1000) {
        setFps(Math.round((frames * 1000) / (now - last)));
        frames = 0;
        last = now;
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [hud]);

  const onPressRow = useCallback((id: string) => {
    setPressedId(prev => (prev === id ? null : id));
  }, []);

  const renderItem = useCallback<NitroListRenderItem<StressItem>>(
    ({ item, target }) => (
      <Row
        item={item}
        selected={item.id === pressedId}
        isSticky={target === 'StickyHeader'}
        onPress={onPressRow}
      />
    ),
    [pressedId, onPressRow]
  );

  const keyExtractor = useCallback((item: StressItem) => item.id, []);
  const getItemType = useCallback((item: StressItem) => item.kind, []);

  const onViewableItemsChanged = useCallback<NitroListOnViewableItemsChanged<StressItem>>(
    ({ viewableItems }) => {
      if (viewableItems.length === 0) {
        setVisibleWindow(null);
        return;
      }
      let first = Number.MAX_SAFE_INTEGER;
      let last = -1;
      for (const token of viewableItems) {
        if (token.index == null) continue;
        if (token.index < first) first = token.index;
        if (token.index > last) last = token.index;
      }
      setVisibleWindow(last >= 0 ? [first, last] : null);
    },
    []
  );

  const viewabilityConfig = useMemo(
    () => ({ itemVisiblePercentThreshold: 50, minimumViewTime: 150 }),
    []
  );

  const onEndReached = useCallback(() => {
    setEdgeHits(prev => ({ ...prev, end: prev.end + 1 }));
  }, []);
  const onStartReached = useCallback(() => {
    setEdgeHits(prev => ({ ...prev, start: prev.start + 1 }));
  }, []);

  const hudLines = useMemo(() => {
    if (!hud) return [];
    const lines: string[] = [];
    const vis = visibleWindow ? `${visibleWindow[0]}–${visibleWindow[1]}` : '–';
    lines.push(
      `fps ${fps} · items ${dataState.items.length} · visible ${vis} · end×${edgeHits.end} start×${edgeHits.start}`
    );
    const s = snapshot;
    if (s?.enabled) {
      lines.push(
        `blank ${s.blankSamples}/${s.scrollSamples} max ${Math.round(s.blankPxMax)}px · 1st range ${
          s.firstRangeLatencyMs != null ? `${Math.round(s.firstRangeLatencyMs)}ms` : '–'
        }`
      );
      const jsiPerSec = s.windowMs > 0 ? Math.round((s.jsiCalls / s.windowMs) * 1000) : 0;
      const batch =
        s.batchFlushes > 0
          ? `${(s.batchPairsSum / s.batchFlushes).toFixed(1)}/${s.batchPairsMax}`
          : '–';
      lines.push(`jsi/s ${jsiPerSec} · ranges ${s.rangeEvents} · batch ${batch}`);
      lines.push(
        `mounts ${s.itemMounts} · unmounts ${s.itemUnmounts} · renders ${s.itemRenders} · burst p95 ${Math.round(
          s.mountBurst.p95
        )}`
      );
      if (s.lastScrollToIndex) {
        lines.push(
          `scrollToIndex ${Math.round(s.lastScrollToIndex.durationMs)}ms · corrections ${
            s.lastScrollToIndex.correctionPasses
          }`
        );
      }
    }
    return lines;
  }, [hud, fps, dataState.items.length, visibleWindow, edgeHits, snapshot]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>NitroList stress lab</Text>
        <View style={styles.chipRow}>
          {SCENARIO_KEYS.map(key => (
            <Chip
              key={key}
              label={SCENARIOS[key].label}
              active={scenario === key}
              tone="list"
              onPress={() => selectScenario(key)}
            />
          ))}
        </View>
        <View style={styles.chipRow}>
          <Chip label="Shuffle" active={false} tone="list" onPress={shuffle} />
          <Chip label="Resize" active={false} tone="list" onPress={reroll} />
          <Chip label="Churn" active={churn} tone="list" onPress={() => setChurn(v => !v)} />
          <Chip
            label="UI scroll"
            active={uiScroll}
            tone="list"
            onPress={() => setUiScroll(v => !v)}
          />
        </View>
        <View style={styles.chipRow}>
          <Chip
            label="Top"
            active={false}
            tone="scroll"
            onPress={() => listRef.current?.scrollToIndex({ index: 0, animated: true })}
          />
          <Chip
            label="End"
            active={false}
            tone="scroll"
            onPress={() => listRef.current?.scrollToEnd(true)}
          />
          <Chip label="Random" active={false} tone="scroll" onPress={jumpRandom} />
          <Chip
            label="Auto ↓"
            active={autoScroll === 1}
            tone="scroll"
            onPress={() => toggleAutoScroll(1)}
          />
          <Chip
            label="Auto ↑"
            active={autoScroll === -1}
            tone="scroll"
            onPress={() => toggleAutoScroll(-1)}
          />
          <Chip
            label={`${velocity} dp/s`}
            active={false}
            tone="scroll"
            onPress={cycleVelocity}
          />
          <Chip label="Torture" active={torture} tone="scroll" onPress={toggleTorture} />
        </View>
        <View style={styles.chipRow}>
          <Chip label="HUD" active={hud} tone="debug" onPress={() => setHud(v => !v)} />
          <Chip
            label="Reset perf"
            active={false}
            tone="debug"
            onPress={() => {
              NitroListPerfMonitor.reset();
              setEdgeHits({ end: 0, start: 0 });
            }}
          />
          <Chip label="QA" active={false} tone="debug" onPress={onOpenQA} />
          {NITRO_LIST_PERF_COMPILED ? (
            <Chip label="Bench" active={false} tone="debug" onPress={onOpenBench} />
          ) : null}
        </View>
      </View>
      <View style={styles.listContainer}>
        <NitroList
          key={`${scenario}-${uiScroll ? 'ui' : 'js'}`}
          ref={listRef}
          data={dataState.items}
          dataVersion={dataState.version}
          renderItem={renderItem}
          estimatedItemSize={estimatedItemSize}
          keyExtractor={keyExtractor}
          getItemType={getItemType}
          stickyHeaderIndices={stickyIndices}
          experimentalUiThreadScroll={uiScroll}
          maintainVisibleContentPosition={churn}
          ListHeaderComponent={ListHeader}
          ListFooterComponent={ListFooter}
          ItemSeparatorComponent={scenario === 'dynamic-50k' ? Separator : null}
          viewabilityConfig={viewabilityConfig}
          onViewableItemsChanged={onViewableItemsChanged}
          onEndReached={onEndReached}
          onStartReached={onStartReached}
        />
        {hud && hudLines.length > 0 ? (
          <Pressable style={styles.hud} onPress={() => NitroListPerfMonitor.reset()}>
            {hudLines.map(line => (
              <Text key={line} style={styles.hudLine}>
                {line}
              </Text>
            ))}
          </Pressable>
        ) : null}
      </View>
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
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  tabRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 6,
  },
  tab: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#5a5a5e',
  },
  tabActive: {
    backgroundColor: '#0a84ff',
    borderColor: '#0a84ff',
  },
  tabLabel: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
  },
  chipLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  listContainer: {
    flex: 1,
  },
  hud: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 24,
    backgroundColor: 'rgba(17, 24, 39, 0.85)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 2,
  },
  hudLine: {
    color: '#e5e7eb',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  listEdge: {
    textAlign: 'center',
    paddingVertical: 12,
    color: '#9ca3af',
    fontSize: 12,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#d1d5db',
    marginHorizontal: 16,
  },
  row: {
    minHeight: 56,
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e5e5',
    backgroundColor: '#fff',
  },
  rowSelected: {
    backgroundColor: '#dbeafe',
  },
  mediaRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e5e5',
    backgroundColor: '#fff',
  },
  hero: {
    width: '100%',
    borderRadius: 10,
    backgroundColor: '#f3f4f6',
  },
  thumbRow: {
    flexDirection: 'row',
    gap: 6,
  },
  thumb: {
    width: 72,
    height: 72,
    borderRadius: 8,
    backgroundColor: '#f3f4f6',
  },
  card: {
    marginHorizontal: 12,
    marginVertical: 8,
    padding: 12,
    gap: 10,
    borderRadius: 12,
    backgroundColor: '#fff',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#d1d5db',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  cardHeaderText: {
    flex: 1,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#f3f4f6',
  },
  cardBody: {
    fontSize: 14,
    lineHeight: 20,
    color: '#374151',
  },
  cardActions: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingTop: 2,
  },
  cardAction: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1d4ed8',
  },
  sectionHeader: {
    backgroundColor: '#f3f4f6',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#d1d5db',
  },
  sectionHeaderSticky: {
    backgroundColor: '#e0e7ff',
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#4b5563',
    textTransform: 'uppercase',
  },
  title: {
    fontSize: 16,
    fontWeight: '500',
  },
  subtitle: {
    fontSize: 13,
    color: '#777',
  },
});

export default App;
