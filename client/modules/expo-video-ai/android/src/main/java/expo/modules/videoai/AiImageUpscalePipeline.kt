package expo.modules.videoai

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import kotlin.math.max
import kotlin.math.min

internal data class AiImageUpscaleResult(
  val outputUri: String,
  val width: Int,
  val height: Int
)

/**
 * 图片 AI 超分：读入单张图片 → 缩放到安全推理尺寸 → Real-ESRGAN 4x 超分 → 保存到相册。
 *
 * 推理前的降采样是必须的：4x 模型输出像素数是输入的 16 倍，
 * 手机相册原图（如 4000x3000）直接 4x 会得到 16000x12000 的巨大位图，
 * 单张 ARGB 位图就超过 700MB，必然 OOM。这里把输入最长边限制在
 * [MAX_INPUT_EDGE] 内，4x 后最长边约 [MAX_INPUT_EDGE] * 4，仍可控。
 * 超分结果超过 [MAX_SAVE_EDGE] 时再做一次等比降采样（2x 档位时，
 * 直接对 4x 结果缩放到目标 2x 尺寸，质量仍优于纯放大）。
 */
internal class AiImageUpscalePipeline(private val context: Context) {

  fun upscale(inputUri: String, scale: Int, onProgress: (Float) -> Unit): AiImageUpscaleResult {
    require(scale == 2 || scale == 4) { "仅支持 2x 或 4x 超分" }

    onProgress(0.05f)
    val modelRoot = AiModelInstaller.ensure(context)
    if (!AiNativeEngine.isSupported()) {
      throw IllegalStateException("此设备不支持 Vulkan AI 图片超分")
    }

    onProgress(0.15f)
    val source = decodeLimited(inputUri, MAX_INPUT_EDGE)
    try {
      if (!AiNativeEngine.loadImageModel(modelRoot.absolutePath, 4)) {
        throw IllegalStateException(
          AiNativeEngine.lastError().ifBlank { "无法加载图片超分模型" }
        )
      }

      onProgress(0.3f)
      AiNativeEngine.setTileSize(if (scale == 4) TILE_QUALITY else TILE_BALANCED)
      val enhanced = AiNativeEngine.upscaleImage(source)
      try {
        val target = if (scale == 2) {
          // 4x 结果等比缩到 2x：超分重建的细节经过降采样后依然保留，
          // 比直接从原图做双线性放大清晰得多。
          Bitmap.createScaledBitmap(enhanced, source.width * 2, source.height * 2, true)
        } else {
          // 4x 结果若边长超限，等比缩回安全范围（仍远大于原图）
          val edge = max(enhanced.width, enhanced.height)
          if (edge > MAX_SAVE_EDGE) {
            val ratio = MAX_SAVE_EDGE.toFloat() / edge
            Bitmap.createScaledBitmap(
              enhanced,
              (enhanced.width * ratio).toInt(),
              (enhanced.height * ratio).toInt(),
              true
            )
          } else {
            enhanced
          }
        }

        onProgress(0.85f)
        val uri = saveToGallery(target)
        return AiImageUpscaleResult(uri.toString(), target.width, target.height)
      } finally {
        if (enhanced !== source && !enhanced.isRecycled) enhanced.recycle()
      }
    } finally {
      if (!source.isRecycled) source.recycle()
    }
  }

  /** 解码时按最长边限制等比降采样，避免大图直接解码 OOM。 */
  private fun decodeLimited(uri: String, maxEdge: Int): Bitmap {
    val targetUri = Uri.parse(uri)
    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    runCatching {
      if (targetUri.scheme == "content") {
        context.contentResolver.openInputStream(targetUri)?.use {
          BitmapFactory.decodeStream(it, null, options)
        }
      } else {
        BitmapFactory.decodeFile(targetUri.path ?: uri, options)
      }
    }
    require(options.outWidth > 0 && options.outHeight > 0) { "无法读取图片" }

    var sample = 1
    val longEdge = max(options.outWidth, options.outHeight)
    while (longEdge / (sample * 2) >= maxEdge) sample *= 2

    val decodeOptions = BitmapFactory.Options().apply { inSampleSize = sample }
    val bitmap = if (targetUri.scheme == "content") {
      context.contentResolver.openInputStream(targetUri)?.use {
        BitmapFactory.decodeStream(it, null, decodeOptions)
      }
    } else {
      BitmapFactory.decodeFile(targetUri.path ?: uri, decodeOptions)
    } ?: throw IllegalStateException("无法解码图片")

    // 再精确缩放到最长边 == maxEdge（inSampleSize 是 2 的幂，可能缩过头/不够）
    val edge = max(bitmap.width, bitmap.height)
    return if (edge > maxEdge) {
      val ratio = maxEdge.toFloat() / edge
      Bitmap.createScaledBitmap(
        bitmap,
        max(1, (bitmap.width * ratio).toInt()),
        max(1, (bitmap.height * ratio).toInt()),
        true
      ).also { if (it !== bitmap) bitmap.recycle() }
    } else {
      bitmap
    }
  }

  private fun saveToGallery(bitmap: Bitmap): Uri {
    val name = "夜映AI超分_${System.currentTimeMillis()}.png"
    val values = ContentValues().apply {
      put(MediaStore.Images.Media.DISPLAY_NAME, name)
      put(MediaStore.Images.Media.MIME_TYPE, "image/png")
      put(MediaStore.Images.Media.WIDTH, bitmap.width)
      put(MediaStore.Images.Media.HEIGHT, bitmap.height)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/夜映/AI")
        put(MediaStore.Images.Media.IS_PENDING, 1)
      }
    }
    val resolver = context.contentResolver
    val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
      ?: throw IllegalStateException("无法创建相册输出文件")
    try {
      resolver.openOutputStream(uri, "w")?.use { output ->
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
      } ?: throw IllegalStateException("无法写入相册输出文件")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        resolver.update(uri, ContentValues().apply {
          put(MediaStore.Images.Media.IS_PENDING, 0)
        }, null, null)
      }
      return uri
    } catch (error: Throwable) {
      resolver.delete(uri, null, null)
      throw error
    }
  }

  private companion object {
    /**
     * 推理输入最长边：4x 后最长边 = 5120，ARGB 位图约 105MB。
     * 配合 manifest 的 largeHeap=true（heap 上限约 512MB）可安全承载。
     * 刻意高于 1024：输入分辨率直接决定 Real-ESRGAN 能重建多少细节，
     * 手机原图 3000-4000px 若压到 1024 会丢掉大部分细节，超分后"分辨率高了但不清晰"。
     * 超分结果超过 [MAX_SAVE_EDGE] 时再等比降采样到 4096，仍比 1024 直出清晰。
     */
    const val MAX_INPUT_EDGE = 1280
    /** 保存结果最长边：超过则等比降采样。 */
    const val MAX_SAVE_EDGE = 4096
    const val TILE_BALANCED = 256
    const val TILE_QUALITY = 192
  }
}
