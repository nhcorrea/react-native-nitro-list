#include <jni.h>

#include "LayoutCore.hpp"

using margelo::nitro::nitrolist::LayoutCore;

namespace {

LayoutCore* fromHandle(jlong handle) {
  return reinterpret_cast<LayoutCore*>(handle);
}

}

extern "C" {

JNIEXPORT jlong JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeCreate(JNIEnv*, jobject) {
  return reinterpret_cast<jlong>(new LayoutCore());
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeDestroy(JNIEnv*, jobject,
                                                                   jlong handle) {
  delete fromHandle(handle);
}

JNIEXPORT jboolean JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeSetItemCount(JNIEnv*,
                                                                        jobject,
                                                                        jlong handle, jint count) {
  return fromHandle(handle)->setItemCount(count) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeSetEstimate(JNIEnv*,
                                                                       jobject,
                                                                       jlong handle, jfloat value) {
  return fromHandle(handle)->setEstimate(value) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeSetMeasurementEpsilon(
    JNIEnv*, jobject, jlong handle, jfloat value) {
  fromHandle(handle)->setMeasurementEpsilon(value);
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeSetDirectionalBuffers(
    JNIEnv*, jobject, jlong handle, jboolean enabled) {
  fromHandle(handle)->setDirectionalBuffers(enabled == JNI_TRUE);
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeSetTypeAverages(
    JNIEnv*, jobject, jlong handle, jboolean enabled) {
  fromHandle(handle)->setTypeAverages(enabled == JNI_TRUE);
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeResetScrollVelocity(
    JNIEnv*, jobject, jlong handle) {
  fromHandle(handle)->resetScrollVelocity();
}

JNIEXPORT jboolean JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeSetEstimatesFrozen(
    JNIEnv*, jobject, jlong handle, jboolean frozen) {
  return fromHandle(handle)->setEstimatesFrozen(frozen == JNI_TRUE) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeSetItemTypes(
    JNIEnv* env, jobject, jlong handle, jobject typesBuffer, jint count) {
  const auto* types =
      typesBuffer != nullptr
          ? static_cast<const uint16_t*>(env->GetDirectBufferAddress(typesBuffer))
          : nullptr;
  fromHandle(handle)->setItemTypes(types, types != nullptr ? count : 0);
}

JNIEXPORT jint JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeFillLayoutSlab(
    JNIEnv* env, jobject, jlong handle, jobject slabBuffer, jint capacityDoubles,
    jfloat scrollOffset, jfloat viewportHeight, jfloat drawDistance, jfloat outputScale) {
  auto* out = static_cast<double*>(env->GetDirectBufferAddress(slabBuffer));
  if (out == nullptr) {
    return -1;
  }
  return fromHandle(handle)->fillLayoutSlab(out, capacityDoubles, scrollOffset, viewportHeight,
                                            drawDistance, outputScale);
}

JNIEXPORT jboolean JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeSetItemSize(JNIEnv*,
                                                                       jobject,
                                                                       jlong handle, jint index,
                                                                       jfloat size) {
  return fromHandle(handle)->setItemSize(index, size) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeSetItemSizesBatch(
    JNIEnv* env, jobject, jlong handle, jobject pairsBuffer, jint pairCount, jfloat scale) {
  const auto* pairs = static_cast<const double*>(env->GetDirectBufferAddress(pairsBuffer));
  if (pairs == nullptr) {
    return JNI_FALSE;
  }
  return fromHandle(handle)->setItemSizes(pairs, pairCount, scale) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jfloat JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeSetItemSizesBatchAnchored(
    JNIEnv* env, jobject, jlong handle, jobject pairsBuffer, jint pairCount, jfloat scale,
    jint anchorIndex) {
  const auto* pairs = static_cast<const double*>(env->GetDirectBufferAddress(pairsBuffer));
  if (pairs == nullptr) {
    return 0.0f;
  }
  return fromHandle(handle)->setItemSizesAnchored(pairs, pairCount, scale, anchorIndex);
}

JNIEXPORT jboolean JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeSeedTypeMeans(
    JNIEnv* env, jobject, jlong handle, jobject pairsBuffer, jint pairCount, jfloat scale) {
  const auto* pairs = static_cast<const double*>(env->GetDirectBufferAddress(pairsBuffer));
  if (pairs == nullptr) {
    return JNI_FALSE;
  }
  return fromHandle(handle)->seedTypeMeans(pairs, pairCount, scale) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeResetItemSizes(JNIEnv*,
                                                                          jobject,
                                                                          jlong handle) {
  return fromHandle(handle)->resetItemSizes() ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeRemapItemSizes(
    JNIEnv* env, jobject, jlong handle, jobject pairsBuffer, jint pairCount) {
  const auto* pairs = static_cast<const double*>(env->GetDirectBufferAddress(pairsBuffer));
  if (pairs == nullptr) {
    return JNI_FALSE;
  }
  return fromHandle(handle)->remapItemSizes(pairs, pairCount) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeResetAll(JNIEnv*,
                                                                    jobject, jlong handle) {
  fromHandle(handle)->resetAll();
}

JNIEXPORT jlong JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeGetMemoryFootprint(JNIEnv*,
                                                                              jobject,
                                                                              jlong handle) {
  return static_cast<jlong>(fromHandle(handle)->getMemoryFootprint());
}

JNIEXPORT jfloat JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeGetTotalSize(JNIEnv*,
                                                                        jobject,
                                                                        jlong handle) {
  return fromHandle(handle)->getTotalSize();
}

JNIEXPORT jfloat JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeGetOffset(JNIEnv*,
                                                                     jobject, jlong handle,
                                                                     jint index) {
  return fromHandle(handle)->getOffset(index);
}

JNIEXPORT jfloat JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeGetSize(JNIEnv*,
                                                                   jobject, jlong handle,
                                                                   jint index) {
  return fromHandle(handle)->getSize(index);
}

JNIEXPORT jint JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeGetLayoutVersion(JNIEnv*,
                                                                            jobject,
                                                                            jlong handle) {
  return fromHandle(handle)->getLayoutVersion();
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeGetEngagedRange(
    JNIEnv* env, jobject, jlong handle, jfloat scrollOffset, jfloat viewportHeight,
    jfloat drawDistance, jintArray out) {
  const LayoutCore::EngagedRange range =
      fromHandle(handle)->getEngagedRange(scrollOffset, viewportHeight, drawDistance);
  const jint values[3] = {range.start, range.end, range.version};
  env->SetIntArrayRegion(out, 0, 3, values);
}

}
