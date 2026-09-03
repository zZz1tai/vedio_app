package expo.modules.videoai

import android.graphics.Bitmap
import android.graphics.ImageFormat
import android.media.Image
import java.nio.ByteBuffer

internal object AiNativeEngine {
  private val loaded: Boolean = runCatching {
    System.loadLibrary("ncnn")
    System.loadLibrary("video_ai")
  }.isSuccess

  external fun nativeIsSupported(): Boolean
  external fun nativeInitialize(modelDirectory: String): Boolean
  external fun nativeLastError(): String
  external fun nativeRifeBackend(): String
  external fun nativeSetTileSize(tileSize: Int)
  external fun nativeUpscale(bitmap: Bitmap): Bitmap?
  external fun nativeLoadImageModel(modelDirectory: String, scale: Int): Boolean
  external fun nativeUpscaleImage(bitmap: Bitmap): Bitmap?
  external fun nativeInterpolate(first: Bitmap, second: Bitmap): Bitmap?
  external fun nativeMotionScore(first: Bitmap, second: Bitmap): Double
  external fun nativeYuvToBitmap(
    yPlane: ByteBuffer,
    yRowStride: Int,
    yPixelStride: Int,
    uPlane: ByteBuffer,
    uRowStride: Int,
    uPixelStride: Int,
    vPlane: ByteBuffer,
    vRowStride: Int,
    vPixelStride: Int,
    width: Int,
    height: Int,
    bitmap: Bitmap
  ): Boolean
  external fun nativeCancel()
  external fun nativeClose()

  fun isSupported(): Boolean = loaded && runCatching { nativeIsSupported() }.getOrDefault(false)

  fun initialize(modelDirectory: String): Boolean =
    loaded && runCatching { nativeInitialize(modelDirectory) }.getOrDefault(false)

  fun lastError(): String =
    if (loaded) runCatching { nativeLastError() }.getOrDefault("") else "AI 原生库加载失败"

  /** 当前 RIFE 实际使用的后端：vulkan / cpu / none，便于日志排查。 */
  fun rifeBackend(): String =
    if (loaded) runCatching { nativeRifeBackend() }.getOrDefault("none") else "none"

  /** 设置 Real-ESRGAN 的分块尺寸，越大越快但占用更多显存。 */
  fun setTileSize(tileSize: Int) {
    if (loaded) runCatching { nativeSetTileSize(tileSize) }
  }

  fun upscale(bitmap: Bitmap): Bitmap =
    nativeUpscale(bitmap) ?: throw IllegalStateException("Real-ESRGAN 推理失败")

  /**
   * 加载图片超分专用模型（realesr-general-x4v3，4x 通用降噪）。
   * [scale] 传 4 时用 4x 模型原生输出；传 2 时原生输出后由调用方降采样到 2x。
   */
  fun loadImageModel(modelDirectory: String, scale: Int = 4): Boolean =
    loaded && runCatching { nativeLoadImageModel(modelDirectory, scale) }.getOrDefault(false)

  /** 用图片 4x 模型对单张位图做超分，返回放大后的新位图。 */
  fun upscaleImage(bitmap: Bitmap): Bitmap =
    nativeUpscaleImage(bitmap) ?: throw IllegalStateException("图片超分推理失败")

  /**
   * 插帧。返回 null 表示本次光流没有收敛，调用方应降级为复制前一帧，
   * 而不是把鬼影帧写进输出。
   */
  fun interpolateOrNull(first: Bitmap, second: Bitmap): Bitmap? =
    runCatching { nativeInterpolate(first, second) }.getOrNull()

  /** 两帧之间的平均绝对差，用于判断运动量；返回负数表示无法比较。 */
  fun motionScore(first: Bitmap, second: Bitmap): Double =
    runCatching { nativeMotionScore(first, second) }.getOrDefault(-1.0)

  /** 把解码器输出的 YUV_420_888 帧写进可复用的 ARGB_8888 位图。 */
  fun yuvToBitmap(image: Image, target: Bitmap): Boolean {
    if (image.format != ImageFormat.YUV_420_888) return false
    if (image.width != target.width || image.height != target.height) return false
    val planes = image.planes
    if (planes.size < 3) return false
    return runCatching {
      nativeYuvToBitmap(
        planes[0].buffer, planes[0].rowStride, planes[0].pixelStride,
        planes[1].buffer, planes[1].rowStride, planes[1].pixelStride,
        planes[2].buffer, planes[2].rowStride, planes[2].pixelStride,
        image.width, image.height,
        target
      )
    }.getOrDefault(false)
  }

  fun cancel() {
    if (loaded) runCatching { nativeCancel() }
  }

  fun close() {
    if (loaded) runCatching { nativeClose() }
  }
}
