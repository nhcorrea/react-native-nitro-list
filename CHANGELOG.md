## [2.5.0](https://github.com/[secure]/react-native-nitro-list/compare/v2.4.0...v2.5.0) (2026-11-02)

### ✨ Features

* **list:** add opt-in eager mount flag ([e1016a8](https://github.com/[secure]/react-native-nitro-list/commit/e1016a8850d8649d821b0e08e3395bfb658d6ac6))
* **list:** skip drawing off-screen items on Android by clipping them ([86682e1](https://github.com/[secure]/react-native-nitro-list/commit/86682e10f1700d06a28fad8c862515727221ca71))
* **list:** warn in dev when cells keep mounting without recycleItems ([1c79251](https://github.com/[secure]/react-native-nitro-list/commit/1c79251c4e82fb93f29ac616f1716746fc48fe4c))

### 🐛 Bug Fixes

* **android:** keep the end clamp from doubling a correction above the anchor ([d9cf098](https://github.com/[secure]/react-native-nitro-list/commit/d9cf098a6dd002cb9a980aed0d278da8ddd9ae33))
* **android:** release unmounted scroll views held for a pending scroll ([991d48a](https://github.com/[secure]/react-native-nitro-list/commit/991d48a06780b226b61e80975538624693478d7f))
* **core:** count frozen size observations in the reported memory ([815a1f9](https://github.com/[secure]/react-native-nitro-list/commit/815a1f922c577541bbbf2944769f0b31502ae93d))
* **core:** reject non-finite and oversized item sizes and type means ([dc8f7b7](https://github.com/[secure]/react-native-nitro-list/commit/dc8f7b712c82a6f81113f3ec2c3526ab672006fd))
* **core:** release frozen observations when resetting layout ([d9e1842](https://github.com/[secure]/react-native-nitro-list/commit/d9e1842a4bdd17d1b7e34a7d3611d3dd551854c0))
* **core:** validate scroll, viewport and config inputs at the engine boundary ([7637e6c](https://github.com/[secure]/react-native-nitro-list/commit/7637e6c3468f135292c34c3aed8cd87b9ca2422d))
* **list:** bound the recycling pool to retained slots ([bfcc183](https://github.com/[secure]/react-native-nitro-list/commit/bfcc18301d57d5a3a9cd20e6ccfb0941737b7385))
* **list:** keep a deep animated jump on target when its momentum outlasts the command ([f597bb2](https://github.com/[secure]/react-native-nitro-list/commit/f597bb2e4895c6415d0a8193ef23dadee4b66b7c))
* **list:** keep a list that lands within a pixel of the start at the start ([f2a0a1c](https://github.com/[secure]/react-native-nitro-list/commit/f2a0a1c5a9c03e4a142fab7ffa1bd32d571d156d))
* **list:** keep position corrections exact near the scroll offset ([3122f01](https://github.com/[secure]/react-native-nitro-list/commit/3122f01e1b517fa25f036e90f7a16bb1dedea712))
* **list:** keep position corrections in step with drags and flings ([160225c](https://github.com/[secure]/react-native-nitro-list/commit/160225c7d79b285a4f104e629b53865d0c60eb31))
* **list:** keep stale scroll events from undoing position corrections ([c38e61e](https://github.com/[secure]/react-native-nitro-list/commit/c38e61ed5ef4ccfd3c7f1ea8fe598408da73f5e6))
* **list:** keep the cell with the focused input rendered off-window ([d7850e8](https://github.com/[secure]/react-native-nitro-list/commit/d7850e82d8957efc3070482a2b1be0ef08879437))
* **list:** keep the idle reserve from clearing the scroll-to-index target ([ca17ca8](https://github.com/[secure]/react-native-nitro-list/commit/ca17ca8ec4281f9fa50ab9501bcab303cd319e8d))
* **list:** land deep animated index jumps on the exact pixel ([adba16a](https://github.com/[secure]/react-native-nitro-list/commit/adba16acf9d81bd93da35914d97e8b0fae7182a9))
* **list:** position deep cells from a float-exact origin ([5a7b9d6](https://github.com/[secure]/react-native-nitro-list/commit/5a7b9d6417e88e0740ab64a5c8350dc5266bc1a0))
* **list:** preserve focused hosts across data permutations ([63c260f](https://github.com/[secure]/react-native-nitro-list/commit/63c260f661873da82620265a253a46de3edd5dea))
* **list:** refresh cell content when data version changes ([de46ba3](https://github.com/[secure]/react-native-nitro-list/commit/de46ba3d7762ca866c7b632c58c18d52a29b7e2b))
* **list:** restore fixed cell measurement wrapper ([f551207](https://github.com/[secure]/react-native-nitro-list/commit/f5512072c07b9dabe88d391392f3dd239f1e1439))
* **list:** restore idle reserve scheduling ([d7dad38](https://github.com/[secure]/react-native-nitro-list/commit/d7dad3888b602e2f9abe961a0ecf226295e226b5))
* **list:** retain focused keys across data remapping ([fa88ca9](https://github.com/[secure]/react-native-nitro-list/commit/fa88ca9c461f4e02c8b831ef8fc401709e43f2f2))
* **list:** stop eager mount cleanups from retaining the first data ([bec4ccf](https://github.com/[secure]/react-native-nitro-list/commit/bec4ccf2c64c0cbae7cfcfdc41bcfc0e938aaeb5))
* **list:** stop native sticky headers from retaining the first data on android ([33d7682](https://github.com/[secure]/react-native-nitro-list/commit/33d76826d969cd7a414ce22e352a751c5090bd3f))
* **list:** stop retaining the first data generation after mount ([8d4ddfa](https://github.com/[secure]/react-native-nitro-list/commit/8d4ddfaddad4481300fdf91685c5e8b611616a27))

### 💨 Performance Improvements

* **android:** pace the fling prewarm by confirmed native mounts ([86e3ed6](https://github.com/[secure]/react-native-nitro-list/commit/86e3ed6e800c773684b505efe912dd6ce96a638c))
* **core:** bias the render window toward the scroll direction ([0118c4c](https://github.com/[secure]/react-native-nitro-list/commit/0118c4ce1a3dcce15a006d48dece9c25d5394e21))
* **core:** update single-column offsets per block ([2066fbe](https://github.com/[secure]/react-native-nitro-list/commit/2066fbe3c9e85bf71848e540ac752e9b10e0f3e7))
* **list:** approach far animated index jumps from two viewports away ([00eda63](https://github.com/[secure]/react-native-nitro-list/commit/00eda63f32b9162529e412bf74f771854909606f))
* **list:** defer idle reserve during scroll ([ec207b4](https://github.com/[secure]/react-native-nitro-list/commit/ec207b48acb83fb7a055e9b10c8df2cc95a257a3))
* **list:** drive Android sticky headers with a native interpolation ([4466939](https://github.com/[secure]/react-native-nitro-list/commit/4466939e1c58a1ff680982b823b08b60028c789e))
* **list:** keep admitted prewarm cells when a touch catches a fling ([3398572](https://github.com/[secure]/react-native-nitro-list/commit/33985724a56f84929c91b94f8f05edb8d01717c7))
* **list:** park cells near the window off screen instead of hiding them ([c17c15d](https://github.com/[secure]/react-native-nitro-list/commit/c17c15d68a98904f444a57f84804f72622eac850))
* **list:** prepare a cell reserve while idle and cap fling prewarm ([c350951](https://github.com/[secure]/react-native-nitro-list/commit/c3509518f5a0712cacba00d4453e98af4cf4db13))
* **list:** render further ahead after the JS thread stalls during motion ([5075ec4](https://github.com/[secure]/react-native-nitro-list/commit/5075ec429ec70a32f2ea4251107fa58b58974cba))
* **list:** reuse a free cell of another type before creating one ([fa52958](https://github.com/[secure]/react-native-nitro-list/commit/fa529585ce28889b7b2f524e4e098deffd6cc728))
* **list:** skip measurement wrapper for fixed cells ([4d07d9c](https://github.com/[secure]/react-native-nitro-list/commit/4d07d9c075740c640c2b30baf4d1f8b730361717))

### 🔄 Code Refactors

* **list:** keep the experimental prepareItem prop out of the public types ([73916bf](https://github.com/[secure]/react-native-nitro-list/commit/73916bfad67b1198c2740fc3c1422c14795b59b4))

## [2.4.0](https://github.com/[secure]/react-native-nitro-list/compare/v2.3.0...v2.4.0) (2026-10-04)

## [2.3.0](https://github.com/[secure]/react-native-nitro-list/compare/v2.2.1...v2.3.0) (2026-09-02)

## [2.2.1](https://github.com/[secure]/react-native-nitro-list/compare/v2.2.0...v2.2.1) (2026-08-28)
