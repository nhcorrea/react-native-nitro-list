import {NitroModules} from './nitroModules';

import type {NitroListEngine} from './NitroListEngine.nitro';

export type {NitroListEngine};

export function createNitroListEngine(): NitroListEngine {
  return NitroModules.createHybridObject<NitroListEngine>('NitroListEngine');
}

export function reportEngineMemory(engine: NitroListEngine): void {
  NitroModules.updateMemorySize(engine);
}
