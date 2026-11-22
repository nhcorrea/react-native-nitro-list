import {Image, type ImageSourcePropType} from 'react-native';

import {NitroModules} from './nitroModules';

export type NativeTemplateAlign = 'flex-start' | 'center' | 'flex-end' | 'stretch';
export type NativeTemplateFontWeight = 'normal' | '500' | '600' | '700' | 'bold';
export type NativeTemplateResizeMode = 'cover' | 'contain' | 'stretch';

export interface NativeTemplateBoxNode {
  type: 'column' | 'row' | 'box';
  id?: string;
  backgroundColor?: string;
  backgroundColorField?: string;
  borderRadius?: number;
  borderBottomWidth?: number;
  borderBottomColor?: string;
  padding?: number;
  paddingHorizontal?: number;
  paddingVertical?: number;
  marginTop?: number;
  marginBottom?: number;
  gap?: number;
  width?: number;
  height?: number;
  maxWidthPercent?: number;
  alignItems?: NativeTemplateAlign;
  alignSelf?: NativeTemplateAlign;
  alignSelfField?: string;
  visibleField?: string;
  pressAction?: string;
  children?: NativeTemplateNode[];
}

export interface NativeTemplateTextNode {
  type: 'text';
  id?: string;
  text?: string;
  textField?: string;
  fontSize?: number;
  fontWeight?: NativeTemplateFontWeight;
  lineHeight?: number;
  color?: string;
  colorField?: string;
  maxLines?: number;
  marginTop?: number;
  marginBottom?: number;
  visibleField?: string;
  pressAction?: string;
}

export interface NativeTemplateImageNode {
  type: 'image';
  id?: string;
  uri?: string;
  uriField?: string;
  width?: number;
  height?: number;
  aspectRatio?: number;
  aspectRatioField?: string;
  borderRadius?: number;
  backgroundColor?: string;
  resizeMode?: NativeTemplateResizeMode;
  marginTop?: number;
  marginBottom?: number;
  visibleField?: string;
  pressAction?: string;
}

export type NativeTemplateNode =
  | NativeTemplateBoxNode
  | NativeTemplateTextNode
  | NativeTemplateImageNode;

export type NativeTemplateFieldValue = string | number | boolean | null | undefined;

export interface NativeTemplateConfig<T> {
  /**
   * Opt-in toggle flag. Defaults to `true` when `nativeTemplate` is provided.
   * Set to `false` to fall back cleanly to standard React `renderItem` rendering
   * (useful for feature flags, A/B experiments, or gradual rollouts).
   */
  enabled?: boolean;
  /** Declarative native view tree per template key (defaults to 'default'). */
  templates: Record<string, NativeTemplateNode>;
  /** Maps each item to a template key in `templates` (defaults to 'default'). */
  getTemplateKey?: (item: T, index: number) => string;
  /** Extracts flat field values bound natively on the UI thread without invoking React. */
  extractFields: (item: T, index: number) => Record<string, NativeTemplateFieldValue>;
  /** Optional static nativeID prefix (e.g. 'benchmark-row-') formatted as `${prefix}${index}` natively. */
  nativeIdPrefix?: string;
  /** Optional dynamic nativeID per item (overrides `nativeIdPrefix` when set). */
  getNativeId?: (item: T, index: number) => string | undefined;
  /** Optional testID per item. */
  getTestId?: (item: T, index: number) => string | undefined;
  /** Optional press callback for template nodes that specify `pressAction`. */
  onPress?: (index: number, action: string) => void;
}

export interface CompiledNativeTemplate {
  schemaJson: string;
  templateIndexByKey: Map<string, number>;
  defaultTemplateIndex: number;
  stringFields: string[];
  numberFields: string[];
  nativeIdFieldIdx: number;
  testIdFieldIdx: number;
}

interface WireNode {
  t: 'column' | 'row' | 'box' | 'text' | 'image';
  bg?: string;
  bgF?: number;
  br?: number;
  bbw?: number;
  bbc?: string;
  pl?: number;
  pt?: number;
  pr?: number;
  pb?: number;
  mt?: number;
  mb?: number;
  gap?: number;
  w?: number;
  h?: number;
  mwp?: number;
  ai?: number;
  as?: number;
  asF?: number;
  visF?: number;
  act?: string;
  txt?: string;
  txtF?: number;
  fs?: number;
  fw?: number;
  lh?: number;
  col?: string;
  colF?: number;
  ml?: number;
  uri?: string;
  uriF?: number;
  ar?: number;
  arF?: number;
  rm?: number;
  ch?: WireNode[];
}

function encodeAlign(value: NativeTemplateAlign | undefined): number | undefined {
  switch (value) {
    case 'stretch':
      return 0;
    case 'flex-start':
      return 1;
    case 'center':
      return 2;
    case 'flex-end':
      return 3;
    default:
      return undefined;
  }
}

function encodeFontWeight(value: NativeTemplateFontWeight | undefined): number | undefined {
  switch (value) {
    case 'normal':
      return 400;
    case '500':
      return 500;
    case '600':
      return 600;
    case '700':
    case 'bold':
      return 700;
    default:
      return undefined;
  }
}

function encodeResizeMode(value: NativeTemplateResizeMode | undefined): number | undefined {
  switch (value) {
    case 'cover':
      return 0;
    case 'contain':
      return 1;
    case 'stretch':
      return 2;
    default:
      return undefined;
  }
}

const resolvedUriCache = new Map<unknown, string>();

/**
 * Resolves a React Native image source (`require(...)` asset ID or `{uri}`) into a URI string
 * compatible with native Fresco/UIKit image loading in both debug and release builds.
 */
export function resolveNativeImageUri(source: ImageSourcePropType | string | null | undefined): string {
  if (source == null) return '';
  if (typeof source === 'string') return source;
  const cached = resolvedUriCache.get(source);
  if (cached !== undefined) return cached;
  const resolved = Image.resolveAssetSource(source);
  const uri = resolved?.uri ?? '';
  if (resolvedUriCache.size < 512) {
    resolvedUriCache.set(source, uri);
  }
  return uri;
}

export function compileNativeTemplate<T>(config: NativeTemplateConfig<T>): CompiledNativeTemplate {
  const stringFields: string[] = [];
  const stringFieldMap = new Map<string, number>();
  const numberFields: string[] = [];
  const numberFieldMap = new Map<string, number>();
  const imageFieldSet = new Set<number>();

  const strIdx = (name: string | undefined): number | undefined => {
    if (!name) return undefined;
    let idx = stringFieldMap.get(name);
    if (idx === undefined) {
      idx = stringFields.length;
      stringFields.push(name);
      stringFieldMap.set(name, idx);
    }
    return idx;
  };

  const numIdx = (name: string | undefined): number | undefined => {
    if (!name) return undefined;
    let idx = numberFieldMap.get(name);
    if (idx === undefined) {
      idx = numberFields.length;
      numberFields.push(name);
      numberFieldMap.set(name, idx);
    }
    return idx;
  };

  const compileNode = (node: NativeTemplateNode): WireNode => {
    const out: WireNode = {t: node.type};
    if (node.marginTop != null) out.mt = node.marginTop;
    if (node.marginBottom != null) out.mb = node.marginBottom;
    if (node.visibleField != null) out.visF = numIdx(node.visibleField);
    if (node.pressAction != null) out.act = node.pressAction;

    if (node.type === 'column' || node.type === 'row' || node.type === 'box') {
      if (node.backgroundColor != null) out.bg = node.backgroundColor;
      if (node.backgroundColorField != null) out.bgF = strIdx(node.backgroundColorField);
      if (node.borderRadius != null) out.br = node.borderRadius;
      if (node.borderBottomWidth != null) out.bbw = node.borderBottomWidth;
      if (node.borderBottomColor != null) out.bbc = node.borderBottomColor;
      const p = node.padding ?? 0;
      const pl = node.paddingHorizontal ?? p;
      const pr = node.paddingHorizontal ?? p;
      const pt = node.paddingVertical ?? p;
      const pb = node.paddingVertical ?? p;
      if (pl > 0) out.pl = pl;
      if (pt > 0) out.pt = pt;
      if (pr > 0) out.pr = pr;
      if (pb > 0) out.pb = pb;
      if (node.gap != null) out.gap = node.gap;
      if (node.width != null) out.w = node.width;
      if (node.height != null) out.h = node.height;
      if (node.maxWidthPercent != null) out.mwp = node.maxWidthPercent;
      const ai = encodeAlign(node.alignItems);
      if (ai !== undefined) out.ai = ai;
      const asVal = encodeAlign(node.alignSelf);
      if (asVal !== undefined) out.as = asVal;
      if (node.alignSelfField != null) out.asF = strIdx(node.alignSelfField);
      if (node.children != null && node.children.length > 0) {
        out.ch = node.children.map(compileNode);
      }
    } else if (node.type === 'text') {
      if (node.text != null) out.txt = node.text;
      if (node.textField != null) out.txtF = strIdx(node.textField);
      if (node.fontSize != null) out.fs = node.fontSize;
      const fw = encodeFontWeight(node.fontWeight);
      if (fw !== undefined) out.fw = fw;
      if (node.lineHeight != null) out.lh = node.lineHeight;
      if (node.color != null) out.col = node.color;
      if (node.colorField != null) out.colF = strIdx(node.colorField);
      if (node.maxLines != null) out.ml = node.maxLines;
    } else if (node.type === 'image') {
      if (node.uri != null) out.uri = node.uri;
      if (node.uriField != null) {
        const idx = strIdx(node.uriField)!;
        out.uriF = idx;
        imageFieldSet.add(idx);
      }
      if (node.width != null) out.w = node.width;
      if (node.height != null) out.h = node.height;
      if (node.aspectRatio != null) out.ar = node.aspectRatio;
      if (node.aspectRatioField != null) out.arF = numIdx(node.aspectRatioField);
      if (node.borderRadius != null) out.br = node.borderRadius;
      if (node.backgroundColor != null) out.bg = node.backgroundColor;
      const rm = encodeResizeMode(node.resizeMode);
      if (rm !== undefined) out.rm = rm;
    }
    return out;
  };

  const templateIndexByKey = new Map<string, number>();
  const wireTemplates: Array<{key: string; root: WireNode}> = [];
  for (const key of Object.keys(config.templates)) {
    templateIndexByKey.set(key, wireTemplates.length);
    wireTemplates.push({key, root: compileNode(config.templates[key]!)});
  }
  const defaultTemplateIndex = templateIndexByKey.get('default') ?? 0;

  const nativeIdFieldIdx = config.getNativeId != null ? strIdx('$nativeId')! : -1;
  const testIdFieldIdx = config.getTestId != null ? strIdx('$testId')! : -1;

  const schemaJson = JSON.stringify({
    v: 1,
    ns: stringFields.length,
    nn: numberFields.length,
    nidF: nativeIdFieldIdx,
    nidP: config.nativeIdPrefix ?? '',
    tidF: testIdFieldIdx,
    imgFs: Array.from(imageFieldSet),
    tmpls: wireTemplates,
  });

  return {
    schemaJson,
    templateIndexByKey,
    defaultTemplateIndex,
    stringFields,
    numberFields,
    nativeIdFieldIdx,
    testIdFieldIdx,
  };
}

function writeUtf8(str: string, out: Uint8Array, pos: number): number {
  const len = str.length;
  let p = pos;
  for (let i = 0; i < len; i++) {
    let code = str.charCodeAt(i);
    if (code < 0x80) {
      out[p++] = code;
    } else if (code < 0x800) {
      out[p++] = 0xc0 | (code >> 6);
      out[p++] = 0x80 | (code & 0x3f);
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
      const next = str.charCodeAt(++i);
      code = 0x10000 + (((code - 0xd800) << 10) | (next - 0xdc00));
      out[p++] = 0xf0 | (code >> 18);
      out[p++] = 0x80 | ((code >> 12) & 0x3f);
      out[p++] = 0x80 | ((code >> 6) & 0x3f);
      out[p++] = 0x80 | (code & 0x3f);
    } else {
      out[p++] = 0xe0 | (code >> 12);
      out[p++] = 0x80 | ((code >> 6) & 0x3f);
      out[p++] = 0x80 | (code & 0x3f);
    }
  }
  return p - pos;
}

function utf8ByteLength(str: string): number {
  const len = str.length;
  let bytes = 0;
  for (let i = 0; i < len; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Packs a contiguous slice `[start, start + count)` of items into a single compact little-endian
 * binary `ArrayBuffer` for zero-JS UI-thread binding. Repeated short strings (image URIs, author
 * names, colors, alignments) are deduplicated so native code can cache parsed `ImageRequest` /
 * `Color` / `String` objects by byte offset in O(1).
 */
export function packNativeTemplateChunk<T>(
  items: ReadonlyArray<T>,
  start: number,
  count: number,
  compiled: CompiledNativeTemplate,
  config: NativeTemplateConfig<T>,
): ArrayBuffer {
  const S = compiled.stringFields.length;
  const F = compiled.numberFields.length;
  const tmplAligned = (count + 3) & ~3;
  const numBytes = count * F * 4;
  const strTableBytes = count * S * 8;
  const strPoolOffset = 16 + tmplAligned + numBytes + strTableBytes;

  // Collect string values and compute exact UTF-8 pool length in pass 1 (deduping short strings).
  const tmplIds = new Uint8Array(count);
  const numVals = new Float32Array(count * F);
  const strOffs = new Int32Array(count * S);
  const strLens = new Int32Array(count * S);
  const dedup = new Map<string, {off: number; len: number}>();
  const poolStrings: string[] = [];
  const poolOffs: number[] = [];
  let poolCursor = 0;

  const internString = (val: string): {off: number; len: number} => {
    if (val.length === 0) return {off: 0, len: 0};
    if (val.length <= 160) {
      const existing = dedup.get(val);
      if (existing !== undefined) return existing;
      const len = utf8ByteLength(val);
      const entry = {off: poolCursor, len};
      dedup.set(val, entry);
      poolStrings.push(val);
      poolOffs.push(poolCursor);
      poolCursor += len;
      return entry;
    }
    const len = utf8ByteLength(val);
    const off = poolCursor;
    poolStrings.push(val);
    poolOffs.push(off);
    poolCursor += len;
    return {off, len};
  };

  const getTemplateKey = config.getTemplateKey;
  const extractFields = config.extractFields;
  const getNativeId = config.getNativeId;
  const getTestId = config.getTestId;
  const strFields = compiled.stringFields;
  const numFields = compiled.numberFields;
  const nidIdx = compiled.nativeIdFieldIdx;
  const tidIdx = compiled.testIdFieldIdx;
  const tmplMap = compiled.templateIndexByKey;
  const defTmpl = compiled.defaultTemplateIndex;

  for (let i = 0; i < count; i++) {
    const idx = start + i;
    const item = items[idx]!;
    tmplIds[i] =
      getTemplateKey != null ? (tmplMap.get(getTemplateKey(item, idx)) ?? defTmpl) : defTmpl;
    const fields = extractFields(item, idx);

    for (let f = 0; f < F; f++) {
      const raw = fields[numFields[f]!];
      if (typeof raw === 'number') {
        numVals[i * F + f] = raw;
      } else if (typeof raw === 'boolean') {
        numVals[i * F + f] = raw ? 1 : 0;
      } else {
        numVals[i * F + f] = Number.NaN;
      }
    }

    for (let s = 0; s < S; s++) {
      let raw: NativeTemplateFieldValue;
      if (s === nidIdx) {
        raw = getNativeId!(item, idx);
      } else if (s === tidIdx) {
        raw = getTestId!(item, idx);
      } else {
        raw = fields[strFields[s]!];
      }
      if (raw == null) {
        strOffs[i * S + s] = 0;
        strLens[i * S + s] = -1;
      } else {
        const str = typeof raw === 'string' ? raw : String(raw);
        const entry = internString(str);
        strOffs[i * S + s] = entry.off;
        strLens[i * S + s] = entry.len;
      }
    }
  }

  const totalBytes = strPoolOffset + ((poolCursor + 3) & ~3);
  const buffer = NitroModules.createNativeArrayBuffer(totalBytes);
  const view = new DataView(buffer);
  view.setInt32(0, count, true);
  view.setInt32(4, S, true);
  view.setInt32(8, F, true);
  view.setInt32(12, strPoolOffset, true);

  const u8 = new Uint8Array(buffer);
  u8.set(tmplIds, 16);

  if (F > 0) {
    const f32 = new Float32Array(buffer, 16 + tmplAligned, count * F);
    f32.set(numVals);
  }

  if (S > 0) {
    const i32 = new Int32Array(buffer, 16 + tmplAligned + numBytes, count * S * 2);
    for (let k = 0; k < count * S; k++) {
      i32[k * 2] = strOffs[k]!;
      i32[k * 2 + 1] = strLens[k]!;
    }
  }

  for (let p = 0; p < poolStrings.length; p++) {
    writeUtf8(poolStrings[p]!, u8, strPoolOffset + poolOffs[p]!);
  }

  return buffer;
}
