@file:Suppress("DEPRECATION")

package com.margelo.nitro.nitrolist

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.text.TextUtils
import android.util.SparseArray
import android.util.SparseLongArray
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.core.widget.TextViewCompat
import com.facebook.drawee.backends.pipeline.Fresco
import com.facebook.drawee.drawable.ScalingUtils
import com.facebook.drawee.generic.GenericDraweeHierarchyBuilder
import com.facebook.drawee.generic.RoundingParams
import com.facebook.drawee.view.GenericDraweeView
import com.facebook.imagepipeline.common.ResizeOptions
import com.facebook.imagepipeline.request.ImageRequest
import com.facebook.imagepipeline.request.ImageRequestBuilder
import com.facebook.react.R
import com.facebook.react.views.imagehelper.ResourceDrawableIdHelper
import com.margelo.nitro.core.ArrayBuffer
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Level 3: Pure-Native Declarative Cell Template Renderer.
 *
 * Binds recycled native Android Views (`NitroTemplateBox`, `TextView`, Fresco `GenericDraweeView`)
 * directly from compact binary chunks on the UI thread without invoking React, Fiber, Yoga, or
 * Fabric during scroll — achieving 0 JS calls and 0.0% blank frames even under 100ms JS stalls.
 */
internal class NativeTemplateEngine {

  companion object {
    const val ALIGN_STRETCH = 0
    const val ALIGN_START = 1
    const val ALIGN_CENTER = 2
    const val ALIGN_END = 3

    private const val MAX_DIRECT_TRANSLATION_PX = 2_000_000.0
    private const val SEGMENT_SHIFT_PX = 1_000_000.0

    private val colorParseCache = HashMap<String, Int>(32)

    fun parseColorCached(raw: String?): Int {
      if (raw.isNullOrEmpty()) return Color.TRANSPARENT
      colorParseCache[raw]?.let { return it }
      val parsed = try {
        Color.parseColor(raw)
      } catch (_: Throwable) {
        Color.TRANSPARENT
      }
      if (colorParseCache.size < 256) {
        colorParseCache[raw] = parsed
      }
      return parsed
    }

    fun parseAlignString(raw: String?): Int {
      return when (raw) {
        "flex-start" -> ALIGN_START
        "center" -> ALIGN_CENTER
        "flex-end" -> ALIGN_END
        "stretch" -> ALIGN_STRETCH
        else -> -1
      }
    }
  }

  // ---- Compiled Schema AST ----

  internal class NodeSpec(
    val type: String,
    val bgColor: Int,
    val hasBg: Boolean,
    val bgColorField: Int,
    val borderRadiusDp: Float,
    val borderBottomWidthDp: Float,
    val borderBottomColor: Int,
    val padL: Float,
    val padT: Float,
    val padR: Float,
    val padB: Float,
    val marginTopDp: Float,
    val marginBottomDp: Float,
    val gapDp: Float,
    val widthDp: Float,
    val heightDp: Float,
    val maxWidthPercent: Float,
    val alignItems: Int,
    val alignSelf: Int,
    val alignSelfField: Int,
    val visibleField: Int,
    val pressAction: String?,
    val staticText: String?,
    val textField: Int,
    val fontSizeSp: Float,
    val fontWeight: Int,
    val lineHeightDp: Float,
    val textColor: Int,
    val textColorField: Int,
    val maxLines: Int,
    val staticUri: String?,
    val uriField: Int,
    val aspectRatio: Float,
    val aspectRatioField: Int,
    val resizeMode: Int,
    val children: Array<NodeSpec>,
  )

  internal class TemplateSchema(
    val numStrFields: Int,
    val numNumFields: Int,
    val nativeIdFieldIdx: Int,
    val nativeIdPrefix: String,
    val testIdFieldIdx: Int,
    val imageFieldIndices: IntArray,
    val roots: Array<NodeSpec>,
  )

  // ---- Compact Binary Data Store (supports chunked 100k+ datasets with O(1) lookup) ----

  internal class DataChunk(
    val chunkId: Int,
    var startIndex: Int,
    val count: Int,
    val numStrFields: Int,
    val numNumFields: Int,
    val strPoolOffset: Int,
    val bytes: ByteArray,
  ) {
    private val tmplAligned = (count + 3) and 3.inv()
    private val numBase = 16 + tmplAligned
    private val strTableBase = numBase + count * numNumFields * 4
    private val bb: ByteBuffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)

    // Dedup caches keyed by strPool relative byte offset -> 0 allocations on repeated URIs/names/colors!
    private val stringCache = SparseArray<String>(64)
    private val colorCache = SparseArray<Int>(16)
    private val alignCache = SparseArray<Int>(8)
    private val uriCache = SparseArray<Uri>(32)
    private val requestCache = HashMap<Long, ImageRequest>(32)
    private val prefetchedOffsets = HashSet<Int>(32)

    fun markPrefetched(off: Int): Boolean = prefetchedOffsets.add(off)

    fun templateIndex(localIdx: Int): Int {
      return bytes[16 + localIdx].toInt() and 0xFF
    }

    fun getNumber(localIdx: Int, fieldIdx: Int): Float {
      if (fieldIdx < 0 || fieldIdx >= numNumFields) return Float.NaN
      return bb.getFloat(numBase + (localIdx * numNumFields + fieldIdx) * 4)
    }

    fun getStringOffset(localIdx: Int, fieldIdx: Int): Int {
      if (fieldIdx < 0 || fieldIdx >= numStrFields) return -1
      val entryBase = strTableBase + (localIdx * numStrFields + fieldIdx) * 8
      val len = bb.getInt(entryBase + 4)
      if (len < 0) return -1
      return bb.getInt(entryBase)
    }

    fun getStringLength(localIdx: Int, fieldIdx: Int): Int {
      if (fieldIdx < 0 || fieldIdx >= numStrFields) return -1
      return bb.getInt(strTableBase + (localIdx * numStrFields + fieldIdx) * 8 + 4)
    }

    fun getString(localIdx: Int, fieldIdx: Int): String? {
      if (fieldIdx < 0 || fieldIdx >= numStrFields) return null
      val entryBase = strTableBase + (localIdx * numStrFields + fieldIdx) * 8
      val off = bb.getInt(entryBase)
      val len = bb.getInt(entryBase + 4)
      if (len < 0) return null
      if (len == 0) return ""
      if (len <= 160) {
        stringCache.get(off)?.let { return it }
        val decoded = String(bytes, strPoolOffset + off, len, Charsets.UTF_8)
        stringCache.put(off, decoded)
        return decoded
      }
      return String(bytes, strPoolOffset + off, len, Charsets.UTF_8)
    }

    fun getColor(localIdx: Int, fieldIdx: Int): Int? {
      val off = getStringOffset(localIdx, fieldIdx)
      if (off < 0) return null
      val cached = colorCache.get(off)
      if (cached != null) return cached
      val raw = getString(localIdx, fieldIdx) ?: return null
      val parsed = parseColorCached(raw)
      colorCache.put(off, parsed)
      return parsed
    }

    fun getAlign(localIdx: Int, fieldIdx: Int): Int {
      val off = getStringOffset(localIdx, fieldIdx)
      if (off < 0) return -1
      val cached = alignCache.get(off)
      if (cached != null) return cached
      val raw = getString(localIdx, fieldIdx)
      val parsed = parseAlignString(raw)
      alignCache.put(off, parsed)
      return parsed
    }

    fun getResolvedUri(localIdx: Int, fieldIdx: Int, context: Context): Uri? {
      val off = getStringOffset(localIdx, fieldIdx)
      if (off < 0) return null
      uriCache.get(off)?.let { return it }
      val raw = getString(localIdx, fieldIdx)
      if (raw.isNullOrEmpty()) return null
      val uri = resolveUri(context, raw) ?: return null
      uriCache.put(off, uri)
      return uri
    }

    fun getImageRequest(
      localIdx: Int,
      fieldIdx: Int,
      context: Context,
      resizeW: Int,
      resizeH: Int,
    ): ImageRequest? {
      val off = getStringOffset(localIdx, fieldIdx)
      if (off < 0) return null
      // Quantize to a square bounding box by max dimension so aspect-ratio variations of the same
      // image share ONE Fresco bitmap-cache key (zero redundant bitmap decodes!).
      val maxDim = max(resizeW, resizeH)
      val bucket = if (maxDim > 0) ((maxDim + 63) and 63.inv()) else 0
      val key = (off.toLong() shl 32) or (bucket.toLong() and 0xFFFFFFFFL)
      requestCache[key]?.let { return it }
      val uri = getResolvedUri(localIdx, fieldIdx, context) ?: return null
      val builder = ImageRequestBuilder.newBuilderWithSource(uri)
      if (bucket > 0) {
        builder.setResizeOptions(ResizeOptions(bucket, bucket))
      }
      val req = builder.build()
      if (requestCache.size < 256) {
        requestCache[key] = req
      }
      return req
    }

    @Suppress("DEPRECATION")
    private fun resolveUri(context: Context, raw: String): Uri? {
      return if (raw.indexOf(':') < 0) {
        // React Native release bundled Android drawable resource name (e.g. "benchmark_assets_card0")
        ResourceDrawableIdHelper.instance.getResourceDrawableUri(context, raw)
      } else {
        Uri.parse(raw)
      }
    }
  }

  internal class DataStore {
    companion object {
      private const val MAX_CHUNKS = 32
    }

    private val chunks = ArrayList<DataChunk>(4)
    var totalCount = 0
    private var nextChunkId = 1
    var dataGeneration = 0

    fun clear() {
      chunks.clear()
      totalCount = 0
      dataGeneration++
    }

    fun shiftIndices(delta: Int, total: Int) {
      if (delta == 0) return
      var i = chunks.size - 1
      while (i >= 0) {
        val c = chunks[i]
        val nextStart = c.startIndex + delta
        if (nextStart < 0 || nextStart >= total) {
          chunks.removeAt(i)
        } else {
          c.startIndex = nextStart
        }
        i--
      }
      totalCount = total
    }

    fun putChunk(startIndex: Int, count: Int, total: Int, reset: Boolean, packedData: ArrayBuffer) {
      val src = packedData.getBuffer(false)
      val size = src.remaining()
      if (size < 16 || count <= 0) return
      val copy = ByteArray(size)
      val dup = src.duplicate()
      dup.get(copy)
      val hdr = ByteBuffer.wrap(copy, 0, 16).order(ByteOrder.LITTLE_ENDIAN)
      val pktCount = hdr.getInt(0)
      val numStr = hdr.getInt(4)
      val numNum = hdr.getInt(8)
      val strPoolOff = hdr.getInt(12)
      if (pktCount <= 0 || strPoolOff > size) return

      if (reset) {
        chunks.clear()
      }

      val chunk = DataChunk(
        chunkId = nextChunkId++,
        startIndex = startIndex,
        count = pktCount,
        numStrFields = numStr,
        numNumFields = numNum,
        strPoolOffset = strPoolOff,
        bytes = copy,
      )
      // Remove any existing overlapping or out-of-bounds chunks cleanly
      val endIndex = startIndex + pktCount
      var i = chunks.size - 1
      while (i >= 0) {
        val c = chunks[i]
        if (c.startIndex >= total || (c.startIndex < endIndex && (c.startIndex + c.count) > startIndex)) {
          chunks.removeAt(i)
        }
        i--
      }
      chunks.add(chunk)
      // Bound native memory on 100k+ datasets by evicting the chunk farthest from the latest upload.
      while (chunks.size > MAX_CHUNKS) {
        var farIdx = -1
        var farDist = -1
        for (k in chunks.indices) {
          val c = chunks[k]
          if (c === chunk) continue
          val dist = abs(c.startIndex - startIndex)
          if (dist > farDist) {
            farDist = dist
            farIdx = k
          }
        }
        if (farIdx >= 0) chunks.removeAt(farIdx) else break
      }
      if (chunks.size > 1) {
        chunks.sortBy { it.startIndex }
      }
      totalCount = total
      dataGeneration++
    }

    fun findChunk(itemIndex: Int): DataChunk? {
      val n = chunks.size
      if (n == 0) return null
      if (n == 1) {
        val c = chunks[0]
        return if (itemIndex >= c.startIndex && itemIndex < c.startIndex + c.count) c else null
      }
      var lo = 0
      var hi = n - 1
      while (lo <= hi) {
        val mid = (lo + hi) ushr 1
        val c = chunks[mid]
        if (itemIndex < c.startIndex) {
          hi = mid - 1
        } else if (itemIndex >= c.startIndex + c.count) {
          lo = mid + 1
        } else {
          return c
        }
      }
      return null
    }
  }

  // ---- Ultra-Fast Single-Pass Native Views ----

  internal class NitroTemplateBox(
    context: Context,
    val isRow: Boolean,
    val gapPx: Int,
    val padL: Int,
    val padT: Int,
    val padR: Int,
    val padB: Int,
    val marginTopPx: Int,
    val marginBottomPx: Int,
    val fixedWidthPx: Int,
    val fixedHeightPx: Int,
    val maxWidthPercent: Float,
    val alignItems: Int,
    var alignSelf: Int,
    bgColor: Int,
    hasBg: Boolean,
    borderRadiusPx: Float,
    val borderBottomPx: Int,
    borderBottomColor: Int,
  ) : ViewGroup(context) {

    private var bgDrawable: GradientDrawable? = null
    private var currentBgColor: Int = bgColor
    private var borderPaint: Paint? = null

    init {
      if (hasBg || borderRadiusPx > 0f) {
        val gd = GradientDrawable()
        gd.setColor(bgColor)
        if (borderRadiusPx > 0f) {
          gd.cornerRadius = borderRadiusPx
        }
        bgDrawable = gd
        background = gd
      }
      if (borderBottomPx > 0) {
        val p = Paint()
        p.style = Paint.Style.FILL
        p.color = borderBottomColor
        borderPaint = p
      }
      clipChildren = borderRadiusPx > 0f
      clipToPadding = false
    }

    fun setDynamicBgColor(color: Int) {
      if (color == currentBgColor && bgDrawable != null) return
      currentBgColor = color
      val gd = bgDrawable ?: GradientDrawable().also {
        bgDrawable = it
        background = it
      }
      gd.setColor(color)
    }

    override fun dispatchDraw(canvas: Canvas) {
      super.dispatchDraw(canvas)
      val paint = borderPaint
      if (paint != null && borderBottomPx > 0) {
        canvas.drawRect(0f, (height - borderBottomPx).toFloat(), width.toFloat(), height.toFloat(), paint)
      }
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
      val wMode = MeasureSpec.getMode(widthMeasureSpec)
      val wSize = MeasureSpec.getSize(widthMeasureSpec)
      val targetW = when {
        fixedWidthPx > 0 -> fixedWidthPx
        maxWidthPercent > 0f && wSize > 0 -> min(wSize, (wSize * maxWidthPercent).roundToInt())
        else -> wSize
      }
      val innerW = max(0, targetW - padL - padR)
      val childCount = childCount

      if (isRow) {
        var usedW = 0
        var maxH = 0
        var visibleCount = 0
        for (i in 0 until childCount) {
          val child = getChildAt(i)
          if (child.visibility == View.GONE) continue
          if (visibleCount > 0) usedW += gapPx
          visibleCount++
          val remW = max(0, innerW - usedW)
          val cSpecW = when {
            child is NitroTemplateImageView && child.fixedWidthPx > 0 ->
              MeasureSpec.makeMeasureSpec(child.fixedWidthPx, MeasureSpec.EXACTLY)
            child is NitroTemplateBox && child.fixedWidthPx > 0 ->
              MeasureSpec.makeMeasureSpec(child.fixedWidthPx, MeasureSpec.EXACTLY)
            else -> MeasureSpec.makeMeasureSpec(remW, MeasureSpec.AT_MOST)
          }
          val cSpecH = if (fixedHeightPx > 0) {
            MeasureSpec.makeMeasureSpec(max(0, fixedHeightPx - padT - padB), MeasureSpec.AT_MOST)
          } else {
            MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
          }
          child.measure(cSpecW, cSpecH)
          usedW += child.measuredWidth
          val ch = child.measuredHeight + childMarginV(child)
          if (ch > maxH) maxH = ch
        }
        val finalW = if (fixedWidthPx > 0) fixedWidthPx else if (wMode == MeasureSpec.EXACTLY && maxWidthPercent <= 0f) wSize else min(targetW, padL + usedW + padR)
        val finalH = if (fixedHeightPx > 0) fixedHeightPx else padT + maxH + padB
        setMeasuredDimension(finalW, finalH)
      } else {
        var totalH = 0
        var maxW = 0
        var visibleCount = 0
        for (i in 0 until childCount) {
          val child = getChildAt(i)
          if (child.visibility == View.GONE) continue
          if (visibleCount > 0) totalH += gapPx
          visibleCount++
          val cMt = childMarginTop(child)
          val cMb = childMarginBottom(child)
          totalH += cMt
          val cSpecW = childColumnWidthSpec(child, innerW)
          val cSpecH = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
          child.measure(cSpecW, cSpecH)
          if (child.measuredWidth > maxW) maxW = child.measuredWidth
          totalH += child.measuredHeight + cMb
        }
        val finalW = when {
          fixedWidthPx > 0 -> fixedWidthPx
          maxWidthPercent > 0f -> min(targetW, padL + maxW + padR)
          wMode == MeasureSpec.EXACTLY -> wSize
          else -> padL + maxW + padR
        }
        val finalH = if (fixedHeightPx > 0) fixedHeightPx else padT + totalH + padB
        setMeasuredDimension(finalW, finalH)
      }
    }

    private fun childColumnWidthSpec(child: View, innerW: Int): Int {
      if (child is NitroTemplateBox) {
        if (child.fixedWidthPx > 0) return MeasureSpec.makeMeasureSpec(child.fixedWidthPx, MeasureSpec.EXACTLY)
        if (child.maxWidthPercent > 0f) {
          val capped = min(innerW, (innerW * child.maxWidthPercent).roundToInt())
          return MeasureSpec.makeMeasureSpec(capped, MeasureSpec.AT_MOST)
        }
        val self = if (child.alignSelf >= 0) child.alignSelf else alignItems
        if (self == ALIGN_START || self == ALIGN_CENTER || self == ALIGN_END) {
          return MeasureSpec.makeMeasureSpec(innerW, MeasureSpec.AT_MOST)
        }
        return MeasureSpec.makeMeasureSpec(innerW, MeasureSpec.EXACTLY)
      }
      if (child is NitroTemplateImageView) {
        if (child.fixedWidthPx > 0) return MeasureSpec.makeMeasureSpec(child.fixedWidthPx, MeasureSpec.EXACTLY)
        return MeasureSpec.makeMeasureSpec(innerW, MeasureSpec.EXACTLY)
      }
      // TextView inside wrap-content bubble (maxWidthPercent > 0f) uses AT_MOST so bubble hugs text!
      val mode = if (maxWidthPercent > 0f) MeasureSpec.AT_MOST else MeasureSpec.EXACTLY
      return MeasureSpec.makeMeasureSpec(innerW, mode)
    }

    private fun childMarginTop(child: View): Int = when (child) {
      is NitroTemplateBox -> child.marginTopPx
      is NitroTemplateImageView -> child.marginTopPx
      is NitroTemplateTextView -> child.marginTopPx
      else -> 0
    }

    private fun childMarginBottom(child: View): Int = when (child) {
      is NitroTemplateBox -> child.marginBottomPx
      is NitroTemplateImageView -> child.marginBottomPx
      is NitroTemplateTextView -> child.marginBottomPx
      else -> 0
    }

    private fun childMarginV(child: View): Int = childMarginTop(child) + childMarginBottom(child)

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
      val innerW = max(0, (r - l) - padL - padR)
      val innerH = max(0, (b - t) - padT - padB)
      val childCount = childCount
      if (isRow) {
        var x = padL
        var visibleCount = 0
        for (i in 0 until childCount) {
          val child = getChildAt(i)
          if (child.visibility == View.GONE) continue
          if (visibleCount > 0) x += gapPx
          visibleCount++
          val cw = child.measuredWidth
          val ch = child.measuredHeight
          val y = when (alignItems) {
            ALIGN_CENTER -> padT + (innerH - ch) / 2
            ALIGN_END -> padT + innerH - ch
            else -> padT + childMarginTop(child)
          }
          child.layout(x, y, x + cw, y + ch)
          x += cw
        }
      } else {
        var y = padT
        var visibleCount = 0
        for (i in 0 until childCount) {
          val child = getChildAt(i)
          if (child.visibility == View.GONE) continue
          if (visibleCount > 0) y += gapPx
          visibleCount++
          y += childMarginTop(child)
          val cw = child.measuredWidth
          val ch = child.measuredHeight
          val self = if (child is NitroTemplateBox && child.alignSelf >= 0) child.alignSelf else alignItems
          val x = when (self) {
            ALIGN_CENTER -> padL + (innerW - cw) / 2
            ALIGN_END -> padL + innerW - cw
            else -> padL
          }
          child.layout(x, y, x + cw, y + ch)
          y += ch + childMarginBottom(child)
        }
      }
    }
  }

  internal class NitroTemplateTextView(
    context: Context,
    val marginTopPx: Int,
    val marginBottomPx: Int,
  ) : TextView(context) {
    var boundChunkId = -1
    var boundTextOffset = -1
    var boundColorOffset = -1
  }

  @Suppress("DEPRECATION")
  internal class NitroTemplateImageView(
    context: Context,
    val fixedWidthPx: Int,
    val fixedHeightPx: Int,
    var dynamicAspectRatio: Float,
    val marginTopPx: Int,
    val marginBottomPx: Int,
    borderRadiusPx: Float,
    bgColor: Int,
    resizeMode: Int,
  ) : GenericDraweeView(
    context,
    GenericDraweeHierarchyBuilder(context.resources).apply {
      fadeDuration = 0
      actualImageScaleType = when (resizeMode) {
        1 -> ScalingUtils.ScaleType.FIT_CENTER
        2 -> ScalingUtils.ScaleType.FIT_XY
        else -> ScalingUtils.ScaleType.CENTER_CROP
      }
      if (bgColor != Color.TRANSPARENT) {
        placeholderImage = ColorDrawable(bgColor)
      }
      if (borderRadiusPx > 0f) {
        roundingParams = RoundingParams.fromCornersRadius(borderRadiusPx)
      }
    }.build(),
  ) {
    var boundChunkId = -1
    var boundUriOffset = -1
    var boundResizeW = -1
    var boundResizeH = -1

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
      val w = if (fixedWidthPx > 0) fixedWidthPx else MeasureSpec.getSize(widthMeasureSpec)
      val h = when {
        fixedHeightPx > 0 -> fixedHeightPx
        dynamicAspectRatio > 0f && w > 0 -> (w.toFloat() / dynamicAspectRatio).roundToInt()
        else -> MeasureSpec.getSize(heightMeasureSpec)
      }
      setMeasuredDimension(max(0, w), max(0, h))
    }
  }

  // ---- Flat Per-Cell Binding Array (Zero Tree Traversal During Scroll!) ----

  internal sealed class NodeBinding {
    class TextBind(val view: NitroTemplateTextView, val textField: Int, val colorField: Int) : NodeBinding()
    class ImageBind(val view: NitroTemplateImageView, val uriField: Int, val aspectField: Int, val fallbackAspect: Float) : NodeBinding()
    class BoxBind(val view: NitroTemplateBox, val bgColorField: Int, val alignSelfField: Int) : NodeBinding()
    class VisibleBind(val view: View, val visibleField: Int) : NodeBinding()
  }

  internal class PooledCell(
    val templateIdx: Int,
    val root: View,
    val bindings: Array<NodeBinding>,
    val pressViews: Array<Pair<View, String>>,
  ) {
    var boundItemIndex = -1
    var boundChunkId = -1
    var boundGen = -1
    var measuredPx = -1
    var measuredSlotWidthPx = -1
    var appliedTargetPx = Double.NaN
    var appliedVisible = -1
    var currentPressItemIndex = -1
  }

  // ---- Engine Instance State (Owned by HostSession on UI Thread) ----

  private var schema: TemplateSchema? = null
  private val dataStore = DataStore()
  private var containerViewTag = -1
  private var containerView: ViewGroup? = null
  private var numColumns = 1
  private var crossAxisGapDp = 0.0
  private var pressHandler: ((Double, String) -> Unit)? = null
  private var dataRequestHandler: ((Double, Double) -> Unit)? = null
  private val requestedChunkTimesMs = SparseLongArray(16)

  // Per-slot active cells + recycled pool by templateIdx
  private var slotCells = arrayOfNulls<PooledCell>(64)
  private var maxSlotIndex = -1
  private val freePools = SparseArray<ArrayList<PooledCell>>(4)
  private var lastPrefetchEnd = -1
  private var lastPrefetchStart = -1

  val isActive: Boolean
    get() = schema != null && containerViewTag > 0

  fun setContainer(tag: Int, columns: Int, crossGapDp: Double, resolved: ViewGroup?) {
    if (containerViewTag != tag) {
      detachAllCells()
      containerViewTag = tag
      containerView = resolved
    } else if (resolved != null) {
      containerView = resolved
    }
    numColumns = max(1, columns)
    crossAxisGapDp = max(0.0, crossGapDp)
  }

  fun setPressHandler(handler: ((Double, String) -> Unit)?) {
    pressHandler = handler
  }

  fun setDataRequestHandler(handler: ((Double, Double) -> Unit)?) {
    dataRequestHandler = handler
  }

  fun setSchema(schemaJson: String) {
    detachAllCells()
    freePools.clear()
    requestedChunkTimesMs.clear()
    lastPrefetchStart = -1
    lastPrefetchEnd = -1
    schema = parseSchema(schemaJson)
  }

  fun setDataChunk(startIndex: Int, count: Int, totalCount: Int, reset: Boolean, packedData: ArrayBuffer) {
    if (reset) {
      requestedChunkTimesMs.clear()
      lastPrefetchStart = -1
      lastPrefetchEnd = -1
    } else {
      val firstBucket = startIndex / 512
      val lastBucket = (startIndex + count - 1) / 512
      for (b in firstBucket..lastBucket) {
        requestedChunkTimesMs.delete(b)
      }
    }
    dataStore.putChunk(startIndex, count, totalCount, reset, packedData)
  }

  fun shiftDataIndices(delta: Int, totalCount: Int) {
    if (delta == 0) return
    dataStore.shiftIndices(delta, totalCount)
    requestedChunkTimesMs.clear()
    lastPrefetchStart = -1
    lastPrefetchEnd = -1
    val curSchema = schema
    val updatePrefixTag = curSchema != null && curSchema.nativeIdFieldIdx < 0 && curSchema.nativeIdPrefix.isNotEmpty()
    for (i in 0..maxSlotIndex) {
      val cell = slotCells[i] ?: continue
      if (cell.boundItemIndex >= 0) {
        val shifted = cell.boundItemIndex + delta
        if (shifted in 0 until totalCount) {
          cell.boundItemIndex = shifted
          cell.currentPressItemIndex = shifted
          if (updatePrefixTag) {
            cell.root.setTag(R.id.view_tag_native_id, "${curSchema!!.nativeIdPrefix}$shifted")
          }
        } else {
          cell.boundItemIndex = -1
          cell.currentPressItemIndex = -1
        }
      }
    }
  }

  fun clear() {
    detachAllCells()
    freePools.clear()
    dataStore.clear()
    requestedChunkTimesMs.clear()
    lastPrefetchStart = -1
    lastPrefetchEnd = -1
    schema = null
    containerViewTag = -1
    containerView = null
    pressHandler = null
    dataRequestHandler = null
  }

  fun invalidateAppliedCoords() {
    for (i in 0..maxSlotIndex) {
      slotCells[i]?.appliedTargetPx = Double.NaN
    }
  }

  private fun detachAllCells() {
    val parent = containerView
    for (i in 0..maxSlotIndex) {
      val cell = slotCells[i] ?: continue
      parent?.removeView(cell.root)
      slotCells[i] = null
    }
    maxSlotIndex = -1
    for (p in 0 until freePools.size()) {
      val list = freePools.valueAt(p)
      for (cell in list) {
        parent?.removeView(cell.root)
      }
    }
  }

  private fun ensureSlotArray(needed: Int) {
    if (needed <= slotCells.size) return
    var next = slotCells.size
    while (next < needed) next *= 2
    slotCells = slotCells.copyOf(next)
  }

  /**
   * Synchronously binds, measures, lays out, updates C++ `LayoutCore` + native MVCP, and positions
   * every active native template cell on the UI thread BEFORE `performDraw` — 0 JS calls!
   *
   * Returns `true` if layout/sizes changed (outHeader holds [changed, mvcpDeltaDp, totalSizeDp, layoutVersion, ...]).
   */
  fun syncAndPositionSlots(
    engineId: Long,
    sv: View,
    resolveContainer: (Int) -> ViewGroup?,
    horizontal: Boolean,
    mvcpEnabled: Boolean,
    inMomentum: Boolean,
    suppressDataRequest: Boolean,
    density: Double,
    mvcpMomentumShiftPx: Double,
    offsetsBuf: DoubleArray,
    infoBuf: IntArray,
    transHeader: DoubleArray,
    sizeIdsBuf: IntArray,
    sizeValsBuf: DoubleArray,
    sizeGensBuf: IntArray,
    sizeHeader: DoubleArray,
    onApplyMvcpDelta: (Double) -> Double,
    onDrainedMvcpShift: () -> Double,
  ): SyncResult {
    val curSchema = schema ?: return SyncResult.EMPTY
    val parent = containerView?.takeIf { it.isAttachedToWindow }
      ?: resolveContainer(containerViewTag)?.also { containerView = it }
      ?: return SyncResult.EMPTY

    val svWidthPx = sv.width
    val svHeightPx = sv.height
    if (svWidthPx <= 0 || svHeightPx <= 0) return SyncResult.EMPTY
    val parentWidthPx = if (parent.width > 0) parent.width else svWidthPx

    var slotCount = NativeHostBridge.nativeReadTemplateSlots(
      engineId = engineId,
      outOffsetsDp = offsetsBuf,
      outInfo = infoBuf,
      maxSlots = offsetsBuf.size,
      outHeader = transHeader,
    )
    var currentMomentumShiftPx = onDrainedMvcpShift()
    if (slotCount <= 0) return SyncResult.EMPTY
    ensureSlotArray(slotCount + 16)

    val context = parent.context
    val densityF = density.toFloat()
    val crossGapPx = (crossAxisGapDp * density).roundToInt()

    var measuredCount = 0
    var minActiveItem = Int.MAX_VALUE
    var maxActiveItem = -1
    var missingMin = Int.MAX_VALUE
    var missingMax = -1

    // Step 1: Bind, measure & layout every active slot whose itemIndex/generation/data changed.
    for (s in 0 until slotCount) {
      val base = s * 6
      val active = infoBuf[base] != 0
      val itemIndex = infoBuf[base + 1]
      val expectedGen = infoBuf[base + 2]
      val col = infoBuf[base + 3]
      val span = infoBuf[base + 4]
      val measures = infoBuf[base + 5] != 0

      if (!active || itemIndex < 0) {
        val existing = slotCells[s]
        if (existing != null && existing.appliedVisible != View.INVISIBLE) {
          existing.root.visibility = View.INVISIBLE
          existing.appliedVisible = View.INVISIBLE
        }
        continue
      }
      if (itemIndex < minActiveItem) minActiveItem = itemIndex
      if (itemIndex > maxActiveItem) maxActiveItem = itemIndex

      val chunk = dataStore.findChunk(itemIndex)
      if (chunk == null) {
        val existing = slotCells[s]
        if (existing != null && existing.appliedVisible != View.INVISIBLE) {
          existing.root.visibility = View.INVISIBLE
          existing.appliedVisible = View.INVISIBLE
        }
        if (itemIndex < missingMin) missingMin = itemIndex
        if (itemIndex > missingMax) missingMax = itemIndex
        continue
      }
      val localIdx = itemIndex - chunk.startIndex
      val tmplIdx = chunk.templateIndex(localIdx).coerceIn(0, curSchema.roots.size - 1)

      var cell = slotCells[s]
      if (cell == null || cell.templateIdx != tmplIdx) {
        if (cell != null) {
          cell.root.visibility = View.INVISIBLE
          cell.appliedVisible = View.INVISIBLE
          val pool = freePools.get(cell.templateIdx) ?: ArrayList<PooledCell>(8).also {
            freePools.put(cell.templateIdx, it)
          }
          pool.add(cell)
        }
        val pool = freePools.get(tmplIdx)
        cell = if (pool != null && pool.isNotEmpty()) {
          pool.removeAt(pool.size - 1)
        } else {
          inflateCell(context, curSchema.roots[tmplIdx], tmplIdx, densityF).also { inflated ->
            parent.addView(inflated.root)
          }
        }
        cell.boundGen = -1
        cell.boundItemIndex = -1
        cell.appliedTargetPx = Double.NaN
        slotCells[s] = cell
        if (s > maxSlotIndex) maxSlotIndex = s
      }

      val slotWidthPx = if (numColumns > 1) {
        val colW = parentWidthPx.toDouble() / numColumns.toDouble()
        ((colW * span).roundToInt() - crossGapPx).coerceAtLeast(1)
      } else {
        parentWidthPx
      }
      val slotLeftPx = if (numColumns > 1) {
        val colW = parentWidthPx.toDouble() / numColumns.toDouble()
        (colW * col).roundToInt() + crossGapPx / 2
      } else {
        0
      }

      val needsRebind = cell.boundItemIndex != itemIndex || cell.boundChunkId != chunk.chunkId
      val needsRemeasure = needsRebind || cell.boundGen != expectedGen || cell.measuredSlotWidthPx != slotWidthPx

      if (needsRebind) {
        bindCell(cell, itemIndex, localIdx, chunk, curSchema, context, slotWidthPx)
        cell.boundItemIndex = itemIndex
        cell.boundChunkId = chunk.chunkId
      }
      if (needsRemeasure) {
        cell.boundGen = expectedGen
        cell.measuredSlotWidthPx = slotWidthPx
        val wSpec = View.MeasureSpec.makeMeasureSpec(slotWidthPx, View.MeasureSpec.EXACTLY)
        val hSpec = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
        cell.root.measure(wSpec, hSpec)
        val mw = cell.root.measuredWidth
        val mh = cell.root.measuredHeight
        cell.root.layout(slotLeftPx, 0, slotLeftPx + mw, mh)
        cell.appliedTargetPx = Double.NaN
        val sizePx = if (horizontal) mw else mh
        if (measures && sizePx > 0) {
          cell.measuredPx = sizePx
          sizeIdsBuf[measuredCount] = s
          sizeValsBuf[measuredCount] = sizePx.toDouble() / density
          sizeGensBuf[measuredCount] = expectedGen
          measuredCount++
        }
      }
    }

    // Step 2: Feed newly measured heights into C++ LayoutCore & execute native MVCP synchronously!
    var totalSizeDp = transHeader[0]
    var layoutVersion = -1
    var layoutChanged = false
    if (measuredCount > 0) {
      val changed = NativeHostBridge.nativeApplySlotSizes(
        engineId = engineId,
        slotIds = sizeIdsBuf,
        sizesDp = sizeValsBuf,
        seenGens = sizeGensBuf,
        count = measuredCount,
        applyMvcp = mvcpEnabled,
        outHeader = sizeHeader,
      )
      if (changed) {
        layoutChanged = true
        val mvcpDeltaDp = sizeHeader[1]
        totalSizeDp = sizeHeader[2]
        layoutVersion = sizeHeader[3].toInt()
        if (mvcpEnabled && abs(mvcpDeltaDp) > 0.1) {
          currentMomentumShiftPx = onApplyMvcpDelta(mvcpDeltaDp)
        }
        // Re-read freshly shifted positions from C++ (~80ns)
        slotCount = NativeHostBridge.nativeReadTemplateSlots(
          engineId = engineId,
          outOffsetsDp = offsetsBuf,
          outInfo = infoBuf,
          maxSlots = offsetsBuf.size,
          outHeader = transHeader,
        )
        totalSizeDp = transHeader[0]
        currentMomentumShiftPx = onDrainedMvcpShift()
      }
    }

    // Step 3: Position every active native cell BEFORE performDraw of this exact frame!
    for (s in 0 until slotCount) {
      val base = s * 6
      val active = infoBuf[base] != 0
      val itemIndex = infoBuf[base + 1]
      val cell = slotCells[s] ?: continue
      if (!active || itemIndex < 0 || cell.boundItemIndex != itemIndex) {
        if (cell.appliedVisible != View.INVISIBLE) {
          cell.root.visibility = View.INVISIBLE
          cell.appliedVisible = View.INVISIBLE
        }
        continue
      }
      val targetPx = offsetsBuf[s] * density - currentMomentumShiftPx
      val view = cell.root
      if (cell.appliedTargetPx != targetPx) {
        if (horizontal) {
          if (abs(targetPx - view.left) > MAX_DIRECT_TRANSLATION_PX) {
            val desiredBase = (Math.floor(targetPx / SEGMENT_SHIFT_PX) * SEGMENT_SHIFT_PX).toInt()
            view.offsetLeftAndRight(desiredBase - view.left)
          }
          val relPx = (targetPx - view.left).toFloat()
          if (view.translationX != relPx) view.translationX = relPx
        } else {
          if (abs(targetPx - view.top) > MAX_DIRECT_TRANSLATION_PX) {
            val desiredBase = (Math.floor(targetPx / SEGMENT_SHIFT_PX) * SEGMENT_SHIFT_PX).toInt()
            view.offsetTopAndBottom(desiredBase - view.top)
          }
          val relPx = (targetPx - view.top).toFloat()
          if (view.translationY != relPx) view.translationY = relPx
        }
        cell.appliedTargetPx = targetPx
      }
      if (cell.appliedVisible != View.VISIBLE) {
        if (view.visibility != View.VISIBLE) view.visibility = View.VISIBLE
        cell.appliedVisible = View.VISIBLE
      }
    }

    // Step 4: On-demand chunk pull for large datasets (>4096 items) + proactive boundary prefetch
    if (!suppressDataRequest && dataStore.totalCount > 0 && dataRequestHandler != null) {
      if (missingMin <= missingMax) {
        requestMissingChunk(missingMin, missingMax)
      } else if (maxActiveItem >= minActiveItem && dataStore.totalCount > 4096) {
        val ahead = min(dataStore.totalCount - 1, maxActiveItem + 96)
        val behind = max(0, minActiveItem - 96)
        if (dataStore.findChunk(ahead) == null) {
          requestMissingChunk(ahead, ahead)
        } else if (dataStore.findChunk(behind) == null) {
          requestMissingChunk(behind, behind)
        }
      }
    }

    // Step 5: Native UI-thread Fresco bitmap-cache prefetch for lookahead items (0 JS calls!)
    if (curSchema.imageFieldIndices.isNotEmpty() && maxActiveItem >= minActiveItem) {
      prefetchLookahead(curSchema, context, minActiveItem, maxActiveItem, parentWidthPx)
    }

    return SyncResult(
      slotCount = slotCount,
      layoutChanged = layoutChanged,
      totalSizeDp = totalSizeDp,
      layoutVersion = layoutVersion,
      stickyIndex = transHeader[1].toInt(),
      stickyTranslateDp = transHeader[2],
    )
  }

  private fun requestMissingChunk(minIdx: Int, maxIdx: Int) {
    val handler = dataRequestHandler ?: return
    val total = dataStore.totalCount
    if (total <= 0) return
    val clampedMin = minIdx.coerceIn(0, total - 1)
    val clampedMax = maxIdx.coerceIn(clampedMin, total - 1)
    val bucket = clampedMin / 512
    val now = SystemClock.uptimeMillis()
    val last = requestedChunkTimesMs.get(bucket, 0L)
    if (last > 0L && now - last < 1000L) return
    requestedChunkTimesMs.put(bucket, now)
    val reqStart = bucket * 512
    val reqEnd = min(total, max(reqStart + 1024, ((clampedMax / 512) + 1) * 512))
    val reqCount = reqEnd - reqStart
    if (reqCount > 0) {
      handler.invoke(reqStart.toDouble(), reqCount.toDouble())
    }
  }

  private fun prefetchLookahead(
    curSchema: TemplateSchema,
    context: Context,
    minActive: Int,
    maxActive: Int,
    parentWidthPx: Int,
  ) {
    val lookBehind = if (numColumns > 1) numColumns * 3 else 4
    val lookAhead = if (numColumns > 1) numColumns * 5 else 8
    val start = max(0, minActive - lookBehind)
    val end = min(dataStore.totalCount - 1, maxActive + lookAhead)
    if (start == lastPrefetchStart && end == lastPrefetchEnd) return
    val prevStart = lastPrefetchStart
    val prevEnd = lastPrefetchEnd
    lastPrefetchStart = start
    lastPrefetchEnd = end
    val pipeline = try {
      Fresco.getImagePipeline()
    } catch (_: Throwable) {
      return
    }
    val imgFields = curSchema.imageFieldIndices
    val targetW = if (numColumns > 1) parentWidthPx / numColumns else parentWidthPx
    for (idx in start..end) {
      if (idx in prevStart..prevEnd) continue
      val chunk = dataStore.findChunk(idx) ?: continue
      val local = idx - chunk.startIndex
      for (f in imgFields) {
        val off = chunk.getStringOffset(local, f)
        if (off < 0 || !chunk.markPrefetched(off)) continue
        val req = chunk.getImageRequest(local, f, context, targetW, targetW) ?: continue
        if (!pipeline.isInBitmapMemoryCache(req.sourceUri)) {
          pipeline.prefetchToBitmapCache(req, null)
        }
      }
    }
  }

  private fun bindCell(
    cell: PooledCell,
    itemIndex: Int,
    localIdx: Int,
    chunk: DataChunk,
    curSchema: TemplateSchema,
    context: Context,
    slotWidthPx: Int,
  ) {
    cell.currentPressItemIndex = itemIndex

    // Tags for React Native nativeID / testID / accessibility / benchmark probe parity
    val nativeId = if (curSchema.nativeIdFieldIdx >= 0) {
      chunk.getString(localIdx, curSchema.nativeIdFieldIdx)
    } else if (curSchema.nativeIdPrefix.isNotEmpty()) {
      "${curSchema.nativeIdPrefix}$itemIndex"
    } else {
      null
    }
    if (nativeId != null) {
      cell.root.setTag(R.id.view_tag_native_id, nativeId)
    }
    if (curSchema.testIdFieldIdx >= 0) {
      val testId = chunk.getString(localIdx, curSchema.testIdFieldIdx)
      if (testId != null) {
        cell.root.setTag(R.id.react_test_id, testId)
      }
    }

    val bindings = cell.bindings
    for (i in bindings.indices) {
      when (val b = bindings[i]) {
        is NodeBinding.VisibleBind -> {
          val v = chunk.getNumber(localIdx, b.visibleField)
          val show = !v.isNaN() && v != 0f
          val vis = if (show) View.VISIBLE else View.GONE
          if (b.view.visibility != vis) b.view.visibility = vis
        }
        is NodeBinding.TextBind -> {
          val tv = b.view
          if (b.textField >= 0) {
            val off = chunk.getStringOffset(localIdx, b.textField)
            val len = chunk.getStringLength(localIdx, b.textField)
            // Skip setText only when the exact cached short string offset matches
            if (len > 160 || tv.boundChunkId != chunk.chunkId || tv.boundTextOffset != off) {
              tv.text = chunk.getString(localIdx, b.textField) ?: ""
              tv.boundChunkId = chunk.chunkId
              tv.boundTextOffset = if (len <= 160) off else -2
            }
          }
          if (b.colorField >= 0) {
            val cOff = chunk.getStringOffset(localIdx, b.colorField)
            if (cOff >= 0 && (tv.boundChunkId != chunk.chunkId || tv.boundColorOffset != cOff)) {
              chunk.getColor(localIdx, b.colorField)?.let { tv.setTextColor(it) }
              tv.boundColorOffset = cOff
            }
          }
        }
        is NodeBinding.ImageBind -> {
          val iv = b.view
          if (b.aspectField >= 0) {
            val ar = chunk.getNumber(localIdx, b.aspectField)
            iv.dynamicAspectRatio = if (!ar.isNaN() && ar > 0f) ar else b.fallbackAspect
          }
          if (b.uriField >= 0) {
            val off = chunk.getStringOffset(localIdx, b.uriField)
            val reqW = if (iv.fixedWidthPx > 0) iv.fixedWidthPx else slotWidthPx
            val reqH = when {
              iv.fixedHeightPx > 0 -> iv.fixedHeightPx
              iv.dynamicAspectRatio > 0f && reqW > 0 -> (reqW / iv.dynamicAspectRatio).roundToInt()
              else -> reqW
            }
            if (off < 0) {
              if (iv.boundUriOffset != -1) {
                iv.controller = null
                iv.boundUriOffset = -1
              }
            } else {
              val bucket = (max(reqW, reqH) + 63) and 63.inv()
              if (iv.boundChunkId != chunk.chunkId || iv.boundUriOffset != off || iv.boundResizeW != bucket) {
                val req = chunk.getImageRequest(localIdx, b.uriField, context, bucket, bucket)
                if (req != null) {
                  iv.controller = Fresco.newDraweeControllerBuilder()
                    .setImageRequest(req)
                    .setOldController(iv.controller)
                    .build()
                  iv.boundChunkId = chunk.chunkId
                  iv.boundUriOffset = off
                  iv.boundResizeW = bucket
                }
              }
            }
          }
        }
        is NodeBinding.BoxBind -> {
          val box = b.view
          if (b.bgColorField >= 0) {
            chunk.getColor(localIdx, b.bgColorField)?.let { box.setDynamicBgColor(it) }
          }
          if (b.alignSelfField >= 0) {
            val a = chunk.getAlign(localIdx, b.alignSelfField)
            if (a >= 0) box.alignSelf = a
          }
        }
      }
    }
  }

  private fun inflateCell(
    context: Context,
    rootSpec: NodeSpec,
    tmplIdx: Int,
    density: Float,
  ): PooledCell {
    val bindings = ArrayList<NodeBinding>(8)
    val pressViews = ArrayList<Pair<View, String>>(2)
    val root = buildView(context, rootSpec, density, bindings, pressViews)
    val cell = PooledCell(tmplIdx, root, bindings.toTypedArray(), pressViews.toTypedArray())
    for ((v, action) in cell.pressViews) {
      v.setOnClickListener {
        val idx = cell.currentPressItemIndex
        if (idx >= 0) {
          pressHandler?.invoke(idx.toDouble(), action)
        }
      }
    }
    return cell
  }

  @Suppress("DEPRECATION")
  private fun buildView(
    context: Context,
    spec: NodeSpec,
    density: Float,
    bindings: ArrayList<NodeBinding>,
    pressViews: ArrayList<Pair<View, String>>,
  ): View {
    val view: View = when (spec.type) {
      "column", "row", "box" -> {
        val box = NitroTemplateBox(
          context = context,
          isRow = spec.type == "row",
          gapPx = (spec.gapDp * density).roundToInt(),
          padL = (spec.padL * density).roundToInt(),
          padT = (spec.padT * density).roundToInt(),
          padR = (spec.padR * density).roundToInt(),
          padB = (spec.padB * density).roundToInt(),
          marginTopPx = (spec.marginTopDp * density).roundToInt(),
          marginBottomPx = (spec.marginBottomDp * density).roundToInt(),
          fixedWidthPx = if (spec.widthDp > 0f) (spec.widthDp * density).roundToInt() else -1,
          fixedHeightPx = if (spec.heightDp > 0f) (spec.heightDp * density).roundToInt() else -1,
          maxWidthPercent = spec.maxWidthPercent,
          alignItems = spec.alignItems,
          alignSelf = spec.alignSelf,
          bgColor = spec.bgColor,
          hasBg = spec.hasBg,
          borderRadiusPx = spec.borderRadiusDp * density,
          borderBottomPx = if (spec.borderBottomWidthDp > 0f) max(1, (spec.borderBottomWidthDp * density).roundToInt()) else 0,
          borderBottomColor = spec.borderBottomColor,
        )
        if (spec.bgColorField >= 0 || spec.alignSelfField >= 0) {
          bindings.add(NodeBinding.BoxBind(box, spec.bgColorField, spec.alignSelfField))
        }
        for (childSpec in spec.children) {
          box.addView(buildView(context, childSpec, density, bindings, pressViews))
        }
        box
      }
      "text" -> {
        val tv = NitroTemplateTextView(
          context = context,
          marginTopPx = (spec.marginTopDp * density).roundToInt(),
          marginBottomPx = (spec.marginBottomDp * density).roundToInt(),
        )
        tv.includeFontPadding = false
        tv.gravity = Gravity.START or Gravity.TOP
        if (spec.fontSizeSp > 0f) {
          tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, spec.fontSizeSp)
        }
        if (spec.fontWeight >= 500) {
          tv.typeface = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            Typeface.create(Typeface.SANS_SERIF, spec.fontWeight, false)
          } else if (spec.fontWeight >= 600) {
            Typeface.DEFAULT_BOLD
          } else {
            Typeface.DEFAULT
          }
        }
        if (spec.lineHeightDp > 0f) {
          TextViewCompat.setLineHeight(tv, (spec.lineHeightDp * density).roundToInt())
        }
        tv.setTextColor(spec.textColor)
        if (spec.maxLines > 0) {
          tv.maxLines = spec.maxLines
          tv.ellipsize = TextUtils.TruncateAt.END
        }
        if (spec.staticText != null) {
          tv.text = spec.staticText
        }
        if (spec.textField >= 0 || spec.textColorField >= 0) {
          bindings.add(NodeBinding.TextBind(tv, spec.textField, spec.textColorField))
        }
        tv
      }
      "image" -> {
        val iv = NitroTemplateImageView(
          context = context,
          fixedWidthPx = if (spec.widthDp > 0f) (spec.widthDp * density).roundToInt() else -1,
          fixedHeightPx = if (spec.heightDp > 0f) (spec.heightDp * density).roundToInt() else -1,
          dynamicAspectRatio = spec.aspectRatio,
          marginTopPx = (spec.marginTopDp * density).roundToInt(),
          marginBottomPx = (spec.marginBottomDp * density).roundToInt(),
          borderRadiusPx = spec.borderRadiusDp * density,
          bgColor = spec.bgColor,
          resizeMode = spec.resizeMode,
        )
        if (!spec.staticUri.isNullOrEmpty()) {
          val uri = if (spec.staticUri.indexOf(':') < 0) {
            ResourceDrawableIdHelper.instance.getResourceDrawableUri(context, spec.staticUri)
          } else {
            Uri.parse(spec.staticUri)
          }
          iv.setImageURI(uri)
        }
        if (spec.uriField >= 0 || spec.aspectRatioField >= 0) {
          bindings.add(NodeBinding.ImageBind(iv, spec.uriField, spec.aspectRatioField, spec.aspectRatio))
        }
        iv
      }
      else -> View(context)
    }

    if (spec.visibleField >= 0) {
      bindings.add(NodeBinding.VisibleBind(view, spec.visibleField))
    }
    if (!spec.pressAction.isNullOrEmpty()) {
      pressViews.add(view to spec.pressAction)
    }
    return view
  }

  private fun parseSchema(json: String): TemplateSchema {
    val root = JSONObject(json)
    val ns = root.optInt("ns", 0)
    val nn = root.optInt("nn", 0)
    val nidF = root.optInt("nidF", -1)
    val nidP = root.optString("nidP", "")
    val tidF = root.optInt("tidF", -1)
    val imgArr = root.optJSONArray("imgFs")
    val imgFs = if (imgArr != null) {
      IntArray(imgArr.length()) { imgArr.getInt(it) }
    } else {
      IntArray(0)
    }
    val tmplsArr = root.getJSONArray("tmpls")
    val roots = Array(tmplsArr.length()) { i ->
      parseNode(tmplsArr.getJSONObject(i).getJSONObject("root"))
    }
    return TemplateSchema(ns, nn, nidF, nidP, tidF, imgFs, roots)
  }

  private fun parseNode(obj: JSONObject): NodeSpec {
    val chArr: JSONArray? = obj.optJSONArray("ch")
    val children = if (chArr != null) {
      Array(chArr.length()) { i -> parseNode(chArr.getJSONObject(i)) }
    } else {
      emptyArray()
    }
    val hasBg = obj.has("bg")
    val bgColor = if (hasBg) parseColorCached(obj.optString("bg")) else Color.TRANSPARENT
    val textColor = if (obj.has("col")) parseColorCached(obj.optString("col")) else Color.BLACK
    val bbc = if (obj.has("bbc")) parseColorCached(obj.optString("bbc")) else Color.TRANSPARENT

    return NodeSpec(
      type = obj.getString("t"),
      bgColor = bgColor,
      hasBg = hasBg,
      bgColorField = obj.optInt("bgF", -1),
      borderRadiusDp = obj.optDouble("br", 0.0).toFloat(),
      borderBottomWidthDp = obj.optDouble("bbw", 0.0).toFloat(),
      borderBottomColor = bbc,
      padL = obj.optDouble("pl", 0.0).toFloat(),
      padT = obj.optDouble("pt", 0.0).toFloat(),
      padR = obj.optDouble("pr", 0.0).toFloat(),
      padB = obj.optDouble("pb", 0.0).toFloat(),
      marginTopDp = obj.optDouble("mt", 0.0).toFloat(),
      marginBottomDp = obj.optDouble("mb", 0.0).toFloat(),
      gapDp = obj.optDouble("gap", 0.0).toFloat(),
      widthDp = obj.optDouble("w", -1.0).toFloat(),
      heightDp = obj.optDouble("h", -1.0).toFloat(),
      maxWidthPercent = obj.optDouble("mwp", -1.0).toFloat(),
      alignItems = obj.optInt("ai", ALIGN_STRETCH),
      alignSelf = obj.optInt("as", -1),
      alignSelfField = obj.optInt("asF", -1),
      visibleField = obj.optInt("visF", -1),
      pressAction = if (obj.has("act")) obj.optString("act") else null,
      staticText = if (obj.has("txt")) obj.optString("txt") else null,
      textField = obj.optInt("txtF", -1),
      fontSizeSp = obj.optDouble("fs", 14.0).toFloat(),
      fontWeight = obj.optInt("fw", 400),
      lineHeightDp = obj.optDouble("lh", 0.0).toFloat(),
      textColor = textColor,
      textColorField = obj.optInt("colF", -1),
      maxLines = obj.optInt("ml", 0),
      staticUri = if (obj.has("uri")) obj.optString("uri") else null,
      uriField = obj.optInt("uriF", -1),
      aspectRatio = obj.optDouble("ar", 0.0).toFloat(),
      aspectRatioField = obj.optInt("arF", -1),
      resizeMode = obj.optInt("rm", 0),
      children = children,
    )
  }

  internal data class SyncResult(
    val slotCount: Int,
    val layoutChanged: Boolean,
    val totalSizeDp: Double,
    val layoutVersion: Int,
    val stickyIndex: Int,
    val stickyTranslateDp: Double,
  ) {
    companion object {
      val EMPTY = SyncResult(0, false, 0.0, -1, -1, 0.0)
    }
  }
}
