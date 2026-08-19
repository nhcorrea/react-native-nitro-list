// JNI bridge between `views/LayoutManager.kt` and the shared C++ layout
// engine (`cpp/LayoutCore.cpp`). Pure forwarding — all math, caching and
// locking live in the core. Handles are raw pointers boxed in jlong, owned
// by the Kotlin wrapper (created in its initializer, deleted in finalize()).

#include <jni.h>

#include "LayoutCore.hpp"

using margelo::nitro::nitrolist::LayoutCore;

namespace {

LayoutCore* fromHandle(jlong handle) {
  return reinterpret_cast<LayoutCore*>(handle);
}

} // namespace

extern "C" {

JNIEXPORT jlong JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeCreate(JNIEnv* /*env*/, jobject /*self*/) {
  return reinterpret_cast<jlong>(new LayoutCore());
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeDestroy(JNIEnv* /*env*/, jobject /*self*/,
                                                                   jlong handle) {
  delete fromHandle(handle);
}

JNIEXPORT jboolean JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeSetItemCount(JNIEnv* /*env*/,
                                                                        jobject /*self*/,
                                                                        jlong handle, jint count) {
  return fromHandle(handle)->setItemCount(count) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeSetEstimate(JNIEnv* /*env*/,
                                                                       jobject /*self*/,
                                                                       jlong handle, jfloat value) {
  return fromHandle(handle)->setEstimate(value) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeSetMeasurementEpsilon(
    JNIEnv* /*env*/, jobject /*self*/, jlong handle, jfloat value) {
  fromHandle(handle)->setMeasurementEpsilon(value);
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeSetDirectionalBuffers(
    JNIEnv* /*env*/, jobject /*self*/, jlong handle, jboolean enabled) {
  fromHandle(handle)->setDirectionalBuffers(enabled == JNI_TRUE);
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeSetTypeAverages(
    JNIEnv* /*env*/, jobject /*self*/, jlong handle, jboolean enabled) {
  fromHandle(handle)->setTypeAverages(enabled == JNI_TRUE);
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeSetItemTypes(
    JNIEnv* env, jobject /*self*/, jlong handle, jobject typesBuffer, jint count) {
  const auto* types =
      typesBuffer != nullptr
          ? static_cast<const uint16_t*>(env->GetDirectBufferAddress(typesBuffer))
          : nullptr;
  fromHandle(handle)->setItemTypes(types, types != nullptr ? count : 0);
}

JNIEXPORT jint JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeFillLayoutSlab(
    JNIEnv* env, jobject /*self*/, jlong handle, jobject slabBuffer, jint capacityDoubles,
    jfloat scrollOffset, jfloat viewportHeight, jfloat drawDistance, jfloat outputScale) {
  auto* out = static_cast<double*>(env->GetDirectBufferAddress(slabBuffer));
  if (out == nullptr) {
    return -1;
  }
  return fromHandle(handle)->fillLayoutSlab(out, capacityDoubles, scrollOffset, viewportHeight,
                                            drawDistance, outputScale);
}

JNIEXPORT jboolean JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeSetItemSize(JNIEnv* /*env*/,
                                                                       jobject /*self*/,
                                                                       jlong handle, jint index,
                                                                       jfloat size) {
  return fromHandle(handle)->setItemSize(index, size) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeSetItemSizesBatch(
    JNIEnv* env, jobject /*self*/, jlong handle, jobject pairsBuffer, jint pairCount, jfloat scale) {
  // `pairsBuffer` is the direct DoubleBuffer view over the JS Float64Array —
  // zero-copy, valid for the duration of this synchronous call.
  const auto* pairs = static_cast<const double*>(env->GetDirectBufferAddress(pairsBuffer));
  if (pairs == nullptr) {
    return JNI_FALSE;
  }
  return fromHandle(handle)->setItemSizes(pairs, pairCount, scale) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jfloat JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeSetItemSizesBatchAnchored(
    JNIEnv* env, jobject /*self*/, jlong handle, jobject pairsBuffer, jint pairCount, jfloat scale,
    jint anchorIndex) {
  const auto* pairs = static_cast<const double*>(env->GetDirectBufferAddress(pairsBuffer));
  if (pairs == nullptr) {
    return 0.0f;
  }
  return fromHandle(handle)->setItemSizesAnchored(pairs, pairCount, scale, anchorIndex);
}

JNIEXPORT jboolean JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeSeedTypeMeans(
    JNIEnv* env, jobject /*self*/, jlong handle, jobject pairsBuffer, jint pairCount, jfloat scale) {
  const auto* pairs = static_cast<const double*>(env->GetDirectBufferAddress(pairsBuffer));
  if (pairs == nullptr) {
    return JNI_FALSE;
  }
  return fromHandle(handle)->seedTypeMeans(pairs, pairCount, scale) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeResetItemSizes(JNIEnv* /*env*/,
                                                                          jobject /*self*/,
                                                                          jlong handle) {
  return fromHandle(handle)->resetItemSizes() ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeResetAll(JNIEnv* /*env*/,
                                                                    jobject /*self*/, jlong handle) {
  fromHandle(handle)->resetAll();
}

JNIEXPORT jlong JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeGetMemoryFootprint(JNIEnv* /*env*/,
                                                                              jobject /*self*/,
                                                                              jlong handle) {
  return static_cast<jlong>(fromHandle(handle)->getMemoryFootprint());
}

JNIEXPORT jfloat JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeGetTotalSize(JNIEnv* /*env*/,
                                                                        jobject /*self*/,
                                                                        jlong handle) {
  return fromHandle(handle)->getTotalSize();
}

JNIEXPORT jfloat JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeGetOffset(JNIEnv* /*env*/,
                                                                     jobject /*self*/, jlong handle,
                                                                     jint index) {
  return fromHandle(handle)->getOffset(index);
}

JNIEXPORT jfloat JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeGetSize(JNIEnv* /*env*/,
                                                                   jobject /*self*/, jlong handle,
                                                                   jint index) {
  return fromHandle(handle)->getSize(index);
}

JNIEXPORT jint JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeGetLayoutVersion(JNIEnv* /*env*/,
                                                                            jobject /*self*/,
                                                                            jlong handle) {
  return fromHandle(handle)->getLayoutVersion();
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_nitrolist_views_LayoutManager_nativeGetEngagedRange(
    JNIEnv* env, jobject /*self*/, jlong handle, jfloat scrollOffset, jfloat viewportHeight,
    jfloat drawDistance, jintArray out) {
  const LayoutCore::EngagedRange range =
      fromHandle(handle)->getEngagedRange(scrollOffset, viewportHeight, drawDistance);
  const jint values[3] = {range.start, range.end, range.version};
  env->SetIntArrayRegion(out, 0, 3, values);
}

} // extern "C"
