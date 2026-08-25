package expo.modules.videoai

import android.graphics.Bitmap

internal object AiNativeEngine {
  private val loaded: Boolean = runCatching {
    System.loadLibrary("ncnn")
    System.loadLibrary("video_ai")
  }.isSuccess

  external fun nativeIsSupported(): Boolean
  external fun nativeInitialize(modelDirectory: String): Boolean
  external fun nativeLastError(): String
  external fun nativeUpscale(bitmap: Bitmap): Bitmap?
  external fun nativeInterpolate(first: Bitmap, second: Bitmap): Bitmap?
  external fun nativeCancel()
  external fun nativeClose()

  fun isSupported(): Boolean = loaded && runCatching { nativeIsSupported() }.getOrDefault(false)

  fun initialize(modelDirectory: String): Boolean =
    loaded && runCatching { nativeInitialize(modelDirectory) }.getOrDefault(false)

  fun lastError(): String =
    if (loaded) runCatching { nativeLastError() }.getOrDefault("") else "AI 原生库加载失败"

  fun upscale(bitmap: Bitmap): Bitmap =
    nativeUpscale(bitmap) ?: throw IllegalStateException("Real-ESRGAN 推理失败")

  fun interpolate(first: Bitmap, second: Bitmap): Bitmap =
    nativeInterpolate(first, second) ?: throw IllegalStateException("RIFE 插帧失败")

  fun cancel() {
    if (loaded) runCatching { nativeCancel() }
  }

  fun close() {
    if (loaded) runCatching { nativeClose() }
  }
}
