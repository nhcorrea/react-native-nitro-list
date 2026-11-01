# NitroList example

A small app that shows how to use `@nhcorrea/react-native-nitro-list`:

- **Feed** — 10,000 rows with `recycleItems`, item types, a fixed-size row type and `scrollToIndex`.
- **Grid** — three columns with gaps.
- **Sections** — `NitroSectionList` with sticky section headers.
- **Chat** — starts at the end, sticks to new messages and loads older ones on top without moving what you are reading.

## Running it

From the repository root:

```sh
corepack yarn install
cd example
corepack yarn pods      # iOS only
corepack yarn ios       # or: corepack yarn android
```
