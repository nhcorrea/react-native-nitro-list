#include "EngineRegistry.hpp"

#include <jni.h>
#include <algorithm>
#include <cstdint>
#include <vector>

namespace {

using margelo::nitro::nitrolist::EngineRegistry;
using margelo::nitro::nitrolist::SlotDelta;

} // namespace

extern "C" {

JNIEXPORT jint JNICALL
Java_com_margelo_nitro_nitrolist_NativeHostBridge_nativeOnScroll(
    JNIEnv* env,
    jobject /* thiz */,
    jlong engineId,
    jdouble absoluteOffsetDp,
    jdouble velocityDpS,
    jint budgetSlots,
    jboolean captureAnchor,
    jdouble jsLatencyMs,
    jdoubleArray outHeader,
    jintArray outDeltas) {
  auto state = EngineRegistry::instance().find(static_cast<int64_t>(engineId));
  if (state == nullptr) return -1;

  thread_local std::vector<SlotDelta> deltas;
  deltas.clear();
  const auto res = state->onNativeScroll(
      static_cast<double>(absoluteOffsetDp),
      static_cast<double>(velocityDpS),
      static_cast<int32_t>(budgetSlots),
      captureAnchor == JNI_TRUE,
      deltas,
      static_cast<double>(jsLatencyMs));

  if (outHeader != nullptr && env->GetArrayLength(outHeader) >= 10) {
    jdouble header[10] = {
        static_cast<jdouble>(res.deltaCount),
        static_cast<jdouble>(res.slotCount),
        static_cast<jdouble>(res.rangeStart),
        static_cast<jdouble>(res.rangeEnd),
        static_cast<jdouble>(res.layoutVersion),
        static_cast<jdouble>(res.totalSizeDp),
        static_cast<jdouble>(res.stickyIndex),
        static_cast<jdouble>(res.stickyTranslateYDp),
        res.hasMorePending ? 1.0 : 0.0,
        res.changed ? 1.0 : 0.0,
    };
    env->SetDoubleArrayRegion(outHeader, 0, 10, header);
  }

  if (outDeltas != nullptr && res.deltaCount > 0) {
    const jsize maxInts = env->GetArrayLength(outDeltas);
    const int32_t copyCount = std::min<int32_t>(res.deltaCount, maxInts / 4);
    if (copyCount > 0) {
      thread_local std::vector<jint> packed;
      packed.resize(static_cast<size_t>(copyCount) * 4);
      for (int32_t k = 0; k < copyCount; ++k) {
        const auto& d = deltas[static_cast<size_t>(k)];
        packed[static_cast<size_t>(k) * 4 + 0] = static_cast<jint>(d.slotId);
        packed[static_cast<size_t>(k) * 4 + 1] = static_cast<jint>(d.itemIndex);
        packed[static_cast<size_t>(k) * 4 + 2] = static_cast<jint>(d.generation);
        packed[static_cast<size_t>(k) * 4 + 3] = static_cast<jint>(d.flags);
      }
      env->SetIntArrayRegion(outDeltas, 0, copyCount * 4, packed.data());
    }
    return copyCount;
  }

  return static_cast<jint>(res.deltaCount);
}

JNIEXPORT jboolean JNICALL
Java_com_margelo_nitro_nitrolist_NativeHostBridge_nativeApplySlotSizes(
    JNIEnv* env,
    jobject /* thiz */,
    jlong engineId,
    jintArray slotIds,
    jdoubleArray sizesDp,
    jintArray seenGens,
    jint count,
    jboolean applyMvcp,
    jdoubleArray outHeader) {
  auto state = EngineRegistry::instance().find(static_cast<int64_t>(engineId));
  if (state == nullptr || slotIds == nullptr || sizesDp == nullptr || count <= 0) {
    return JNI_FALSE;
  }

  const int32_t n = std::min<int32_t>(
      static_cast<int32_t>(count),
      std::min<int32_t>(env->GetArrayLength(slotIds), env->GetArrayLength(sizesDp)));
  if (n <= 0) return JNI_FALSE;

  thread_local std::vector<int32_t> ids;
  thread_local std::vector<double> sizes;
  thread_local std::vector<uint32_t> gens;
  ids.resize(static_cast<size_t>(n));
  sizes.resize(static_cast<size_t>(n));

  env->GetIntArrayRegion(slotIds, 0, n, reinterpret_cast<jint*>(ids.data()));
  env->GetDoubleArrayRegion(sizesDp, 0, n, reinterpret_cast<jdouble*>(sizes.data()));

  const uint32_t* gensPtr = nullptr;
  if (seenGens != nullptr && env->GetArrayLength(seenGens) >= n) {
    gens.resize(static_cast<size_t>(n));
    env->GetIntArrayRegion(seenGens, 0, n, reinterpret_cast<jint*>(gens.data()));
    gensPtr = gens.data();
  }

  const auto res = state->onNativeSlotSizes(
      ids.data(), sizes.data(), gensPtr, n, applyMvcp == JNI_TRUE);

  if (outHeader != nullptr && env->GetArrayLength(outHeader) >= 6) {
    jdouble header[6] = {
        res.changed ? 1.0 : 0.0,
        static_cast<jdouble>(res.mvcpDeltaDp),
        static_cast<jdouble>(res.totalSizeDp),
        static_cast<jdouble>(res.layoutVersion),
        static_cast<jdouble>(res.stickyIndex),
        static_cast<jdouble>(res.stickyTranslateYDp),
    };
    env->SetDoubleArrayRegion(outHeader, 0, 6, header);
  }

  return res.changed ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jint JNICALL
Java_com_margelo_nitro_nitrolist_NativeHostBridge_nativeReadTransforms(
    JNIEnv* env,
    jobject /* thiz */,
    jlong engineId,
    jdoubleArray outOffsetsDp,
    jintArray outMeta,
    jint maxSlots,
    jdoubleArray outHeader) {
  auto state = EngineRegistry::instance().find(static_cast<int64_t>(engineId));
  if (state == nullptr || outOffsetsDp == nullptr || outMeta == nullptr || maxSlots <= 0) {
    return 0;
  }

  const int32_t cap = std::min<int32_t>(
      static_cast<int32_t>(maxSlots),
      std::min<int32_t>(env->GetArrayLength(outOffsetsDp), env->GetArrayLength(outMeta) / 3));
  if (cap <= 0) return 0;

  thread_local std::vector<double> offsets;
  thread_local std::vector<int32_t> meta;
  offsets.resize(static_cast<size_t>(cap));
  meta.resize(static_cast<size_t>(cap) * 3);
  double totalSizeDp = 0.0;
  int32_t stickyIndex = -1;
  double stickyTranslateYDp = 0.0;
  double pendingMvcpShiftDp = 0.0;

  const int32_t count = state->readSlotTransforms(
      offsets.data(), meta.data(), cap, totalSizeDp, stickyIndex, stickyTranslateYDp,
      &pendingMvcpShiftDp);

  if (count > 0) {
    env->SetDoubleArrayRegion(outOffsetsDp, 0, count, reinterpret_cast<const jdouble*>(offsets.data()));
    env->SetIntArrayRegion(outMeta, 0, count * 3, reinterpret_cast<const jint*>(meta.data()));
  }
  if (outHeader != nullptr && env->GetArrayLength(outHeader) >= 4) {
    jdouble header[4] = {
        static_cast<jdouble>(totalSizeDp),
        static_cast<jdouble>(stickyIndex),
        static_cast<jdouble>(stickyTranslateYDp),
        static_cast<jdouble>(pendingMvcpShiftDp),
    };
    env->SetDoubleArrayRegion(outHeader, 0, 4, header);
  } else if (outHeader != nullptr && env->GetArrayLength(outHeader) >= 3) {
    jdouble header[3] = {
        static_cast<jdouble>(totalSizeDp),
        static_cast<jdouble>(stickyIndex),
        static_cast<jdouble>(stickyTranslateYDp),
    };
    env->SetDoubleArrayRegion(outHeader, 0, 3, header);
  }
  return static_cast<jint>(count);
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_nitrolist_NativeHostBridge_nativeSetSlotViewTag(
    JNIEnv* /* env */,
    jobject /* thiz */,
    jlong engineId,
    jint slotId,
    jint viewTag,
    jboolean measures) {
  auto state = EngineRegistry::instance().find(static_cast<int64_t>(engineId));
  if (state != nullptr) {
    state->setSlotViewTag(static_cast<int32_t>(slotId), static_cast<int32_t>(viewTag), measures == JNI_TRUE);
  }
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_nitrolist_NativeHostBridge_nativeUnregisterSlotView(
    JNIEnv* /* env */,
    jobject /* thiz */,
    jlong engineId,
    jint slotId) {
  auto state = EngineRegistry::instance().find(static_cast<int64_t>(engineId));
  if (state != nullptr) {
    state->unregisterSlotView(static_cast<int32_t>(slotId));
  }
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_nitrolist_NativeHostBridge_nativeSetSlotMeasures(
    JNIEnv* /* env */,
    jobject /* thiz */,
    jlong engineId,
    jint slotId,
    jboolean measures) {
  auto state = EngineRegistry::instance().find(static_cast<int64_t>(engineId));
  if (state != nullptr) {
    state->setSlotMeasures(static_cast<int32_t>(slotId), measures == JNI_TRUE);
  }
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_nitrolist_NativeHostBridge_nativeSetMvcpEnabled(
    JNIEnv* /* env */,
    jobject /* thiz */,
    jlong engineId,
    jboolean enabled) {
  auto state = EngineRegistry::instance().find(static_cast<int64_t>(engineId));
  if (state != nullptr) {
    state->setMvcpEnabled(enabled == JNI_TRUE);
  }
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_nitrolist_NativeHostBridge_nativeUpdateHostGeometry(
    JNIEnv* /* env */,
    jobject /* thiz */,
    jlong engineId,
    jdouble paddingStartDp,
    jdouble mainAxisGapDp) {
  auto state = EngineRegistry::instance().find(static_cast<int64_t>(engineId));
  if (state != nullptr) {
    state->updateHostGeometry(static_cast<double>(paddingStartDp), static_cast<double>(mainAxisGapDp));
  }
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_nitrolist_NativeHostBridge_nativeOnMomentumEnd(
    JNIEnv* /* env */,
    jobject /* thiz */,
    jlong engineId,
    jdouble absoluteOffsetDp) {
  auto state = EngineRegistry::instance().find(static_cast<int64_t>(engineId));
  if (state != nullptr) {
    state->onNativeMomentumEnd(static_cast<double>(absoluteOffsetDp));
  }
}

JNIEXPORT jboolean JNICALL
Java_com_margelo_nitro_nitrolist_NativeHostBridge_nativeIsPrewarmActive(
    JNIEnv* /* env */,
    jobject /* thiz */,
    jlong engineId) {
  auto state = EngineRegistry::instance().find(static_cast<int64_t>(engineId));
  return (state != nullptr && state->isJsPrewarmActive()) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jint JNICALL
Java_com_margelo_nitro_nitrolist_NativeHostBridge_nativeReadTemplateSlots(
    JNIEnv* env,
    jobject /* thiz */,
    jlong engineId,
    jdoubleArray outOffsetsDp,
    jintArray outInfo,
    jint maxSlots,
    jdoubleArray outHeader) {
  auto state = EngineRegistry::instance().find(static_cast<int64_t>(engineId));
  if (state == nullptr || outOffsetsDp == nullptr || outInfo == nullptr || maxSlots <= 0) {
    return 0;
  }

  const int32_t cap = std::min<int32_t>(
      static_cast<int32_t>(maxSlots),
      std::min<int32_t>(env->GetArrayLength(outOffsetsDp), env->GetArrayLength(outInfo) / 6));
  if (cap <= 0) return 0;

  thread_local std::vector<double> offsets;
  thread_local std::vector<int32_t> info;
  offsets.resize(static_cast<size_t>(cap));
  info.resize(static_cast<size_t>(cap) * 6);
  double totalSizeDp = 0.0;
  int32_t stickyIndex = -1;
  double stickyTranslateYDp = 0.0;
  double pendingMvcpShiftDp = 0.0;

  const int32_t count = state->readTemplateSlots(
      offsets.data(), info.data(), cap, totalSizeDp, stickyIndex, stickyTranslateYDp,
      &pendingMvcpShiftDp);

  if (count > 0) {
    env->SetDoubleArrayRegion(outOffsetsDp, 0, count, reinterpret_cast<const jdouble*>(offsets.data()));
    env->SetIntArrayRegion(outInfo, 0, count * 6, reinterpret_cast<const jint*>(info.data()));
  }
  if (outHeader != nullptr && env->GetArrayLength(outHeader) >= 4) {
    jdouble header[4] = {
        static_cast<jdouble>(totalSizeDp),
        static_cast<jdouble>(stickyIndex),
        static_cast<jdouble>(stickyTranslateYDp),
        static_cast<jdouble>(pendingMvcpShiftDp),
    };
    env->SetDoubleArrayRegion(outHeader, 0, 4, header);
  }
  return static_cast<jint>(count);
}

} // extern "C"
