/**
 * Este app é bancada: o NitroListPerfMonitor precisa existir também no APK de
 * release (é lá que os números valem — ver docs/PROFILE.md). O gate da lib
 * (`NITRO_LIST_PERF_COMPILED`) é avaliado no import de PerfMonitor, então esta
 * flag tem que ser escrita antes: daí o módulo separado, importado na primeira
 * linha do index.js.
 */
(globalThis as {__NITRO_LIST_PERF__?: boolean}).__NITRO_LIST_PERF__ = true;

export {};
