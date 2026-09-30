import {setImmediate as realSetImmediate} from 'timers';
import {setFlagsFromString} from 'v8';
import {runInNewContext} from 'vm';

setFlagsFromString('--expose-gc');
const collect = runInNewContext('gc') as () => void;

export async function collectGarbage(): Promise<void> {
  for (let pass = 0; pass < 4; pass++) {
    collect();
    await new Promise<void>((resolve) => realSetImmediate(resolve));
  }
}

export async function reachableLabels(refs: ReadonlyMap<string, WeakRef<object>>): Promise<string[]> {
  await collectGarbage();
  const alive: string[] = [];
  for (const [label, ref] of refs) {
    if (ref.deref() !== undefined) alive.push(label);
  }
  return alive;
}
