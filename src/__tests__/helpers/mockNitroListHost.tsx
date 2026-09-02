import type {NitroListEngine} from '../../NitroListEngine.nitro';
import {HybridNitroListEngineMirror, type HybridMirrorConfig} from './layoutCoreMirror';

const mirrors: HybridNitroListEngineMirror[] = [];
let nextMirrorConfig: HybridMirrorConfig = {};

export function setMirrorConfigForTests(config: HybridMirrorConfig): void {
  nextMirrorConfig = config;
}

export function getLastMirror(): HybridNitroListEngineMirror {
  const mirror = mirrors[mirrors.length - 1];
  if (mirror == null) {
    throw new Error('no NitroList engine has been created yet');
  }
  return mirror;
}

export function clearMirrorsForTests(): void {
  mirrors.length = 0;
  nextMirrorConfig = {};
}

export function createNitroListEngine(): NitroListEngine {
  const mirror = new HybridNitroListEngineMirror(nextMirrorConfig);
  mirrors.push(mirror);
  return mirror;
}

export type {NitroListEngine};
