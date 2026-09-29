import {NitroModules} from 'react-native-nitro-modules';

export function nativeFloat64Array(length: number): Float64Array<ArrayBuffer> {
  const array = new Float64Array(NitroModules.createNativeArrayBuffer(Math.max(1, length) * 8));
  array.fill(0);
  return array;
}

export function nativeUint16Array(length: number): Uint16Array<ArrayBuffer> {
  const array = new Uint16Array(NitroModules.createNativeArrayBuffer(Math.max(1, length) * 2));
  array.fill(0);
  return array;
}

export function growNativeFloat64Array(
  array: Float64Array<ArrayBuffer>,
  minLength: number,
): Float64Array<ArrayBuffer> {
  if (array.length >= minLength) return array;
  const next = nativeFloat64Array(Math.max(minLength, array.length * 2));
  next.set(array);
  return next;
}

let emptyBuffer: ArrayBuffer | null = null;

export function emptyNativeBuffer(): ArrayBuffer {
  emptyBuffer ??= nativeFloat64Array(1).buffer;
  return emptyBuffer;
}
