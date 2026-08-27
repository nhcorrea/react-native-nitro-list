# NitroList example app

Example app and performance bench for [`@nhcorrea/react-native-nitro-list`](../README.md). Three screens:

| Screen | What it's for |
| --- | --- |
| **Bench** (initial) | Reproducible scripted runs that print `NitroListPerfMonitor` snapshots to the console. |
| **Stress lab** | Interactive use: 100k items, images, sticky headers, data churn, auto-scroll, on-screen HUD. Surfaces bugs, not comparable numbers. |
| **QA** | Self-asserting behaviour fixtures — see [`qa/README.md`](qa/README.md). |

## Running

```sh
npm install
npm run pod    # iOS, first clone and after native dep changes
npm run ios    # or: npm run android
```

## Measuring on a release build

Numbers from a debug build are not meaningful — always measure a release build on a physical device.

```sh
npm run apk          # release, arm64
npm run apk:install
npm run apk:launch
npm run bench:logcat # follow the JS console output
```

Useful while measuring:

```sh
npm run bench:stayon      # keep the screen awake (and :off afterwards)
npm run bench:gfx:reset   # reset frame stats, then npm run bench:gfx to read them
```

The release APK compiles `NitroListPerfMonitor` in because `perfFlag.ts` sets the
global before anything else is imported in `index.js`. Without that flag, the
instrumentation compiles out of release builds.
