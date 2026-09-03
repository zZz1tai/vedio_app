package expo.modules.videoai

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.MediaScannerConnection
import android.net.Uri
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES20
import android.opengl.GLUtils
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.view.Surface
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.roundToLong

internal class AiVideoExportCancelledException : RuntimeException()

internal data class AiVideoExportResult(
  val outputUri: String,
  val width: Int,
  val height: Int,
  val fps: Double,
  val totalFrames: Int
)

internal class AiVideoExportPipeline(private val context: Context) {
  fun export(
    request: VideoAiRequest,
    shouldCancel: () -> Boolean,
    onProgress: (VideoAiStage, Double, Int, Int) -> Unit
  ): AiVideoExportResult {
    val source = VideoFrameSource.open(context, request.inputUri)
    return source.use { frameSource ->
      val probe = frameSource.probe
      require(probe.durationUs <= MAX_DURATION_US) {
        "首版 AI 导出仅支持 ${MAX_DURATION_US / 1_000_000} 秒以内的视频"
      }

      val modelRoot = AiModelInstaller.ensure(context)
      if (!AiNativeEngine.initialize(modelRoot.absolutePath)) {
        throw IllegalStateException(
          AiNativeEngine.lastError().ifBlank { "无法初始化 Real-ESRGAN / RIFE 模型" }
        )
      }
      AiNativeEngine.setTileSize(if (request.preset == "quality") TILE_QUALITY else TILE_BALANCED)

      val firstFrame = frameSource.next() ?: throw IllegalStateException("无法解码视频首帧")
      val outputWidth = even(if (request.scale == 2) probe.width * 2 else probe.width)
      val outputHeight = even(if (request.scale == 2) probe.height * 2 else probe.height)
      require(outputWidth <= MAX_OUTPUT_WIDTH && outputHeight <= MAX_OUTPUT_HEIGHT) {
        "输出分辨率超过 ${MAX_OUTPUT_WIDTH}x${MAX_OUTPUT_HEIGHT} 限制"
      }

      // 插帧后帧率翻倍，超出编码器上限时放弃插帧而不是压缩时间戳，
      // 否则实际帧数与帧率对不上，成片会整体变速。
      val sourceFps = probe.fps
      val wantsInterpolation = request.interpolation == "x2"
      val interpolated = wantsInterpolation && sourceFps * 2 <= MAX_OUTPUT_FPS
      val outputFps = if (interpolated) sourceFps * 2 else sourceFps
      val outputFrameDurationUs = max(1L, (1_000_000.0 / outputFps).roundToLong())

      val sourceFrameCount = if (probe.frameCount > 0) {
        probe.frameCount
      } else {
        max(1, ceil(probe.durationUs.toDouble() / (1_000_000.0 / sourceFps)).toInt())
      }
      val estimatedOutputFrames = if (interpolated) {
        max(1, sourceFrameCount * 2 - 1)
      } else {
        sourceFrameCount
      }

      val outputFile = outputFileFor(request.displayName)
      val encoder = H264Mp4Encoder(
        context,
        request.inputUri,
        outputFile,
        outputWidth,
        outputHeight,
        outputFps,
        request.preset,
        probe.rotation
      )

      var previous: Bitmap? = firstFrame
      var encodedFrames = 0
      val throttle = ProgressThrottle(onProgress)

      try {
        onProgress(VideoAiStage.PREPARING, 0.02, 0, estimatedOutputFrames)
        while (true) {
          ensureNotCancelled(shouldCancel)
          val current = frameSource.next() ?: break
          val previousFrame = previous ?: throw IllegalStateException("缺少前一帧")

          // A 帧只超分一次。插帧走降级路径时（重复帧 / 大运动 / 光流未收敛），
          // 中间帧直接复用这份增强结果，省掉一次全尺寸 Real-ESRGAN 推理。
          val enhancedA = enhanceFrame(
            source = previousFrame,
            scale = request.scale,
            targetWidth = outputWidth,
            targetHeight = outputHeight,
            shouldCancel = shouldCancel
          )
          try {
            encoder.writeFrame(enhancedA, encodedFrames * outputFrameDurationUs)
            encodedFrames += 1
            throttle.report(
              VideoAiStage.UPSCALING,
              exportProgress(encodedFrames, estimatedOutputFrames),
              encodedFrames,
              estimatedOutputFrames
            )

            if (interpolated) {
              ensureNotCancelled(shouldCancel)
              throttle.report(
                VideoAiStage.INTERPOLATING,
                exportProgress(encodedFrames, estimatedOutputFrames),
                encodedFrames,
                estimatedOutputFrames
              )
              val intermediate = buildIntermediateFrame(
                previous = previousFrame,
                current = current,
                enhancedPrevious = enhancedA,
                request = request,
                outputWidth = outputWidth,
                outputHeight = outputHeight,
                shouldCancel = shouldCancel
              )
              try {
                encoder.writeFrame(intermediate, encodedFrames * outputFrameDurationUs)
              } finally {
                if (intermediate !== enhancedA && !intermediate.isRecycled) intermediate.recycle()
              }
              encodedFrames += 1
              throttle.report(
                VideoAiStage.UPSCALING,
                exportProgress(encodedFrames, estimatedOutputFrames),
                encodedFrames,
                estimatedOutputFrames
              )
            }
          } finally {
            // 增强结果是独立位图时需要回收；复用源帧本身时则交还解码帧池
            if (enhancedA !== previousFrame && !enhancedA.isRecycled) enhancedA.recycle()
          }

          frameSource.release(previousFrame)
          previous = current
        }

        val finalFrame = previous ?: throw IllegalStateException("无法读取视频帧")
        val enhancedFinal = enhanceFrame(
          source = finalFrame,
          scale = request.scale,
          targetWidth = outputWidth,
          targetHeight = outputHeight,
          shouldCancel = shouldCancel
        )
        try {
          encoder.writeFrame(enhancedFinal, encodedFrames * outputFrameDurationUs)
        } finally {
          if (enhancedFinal !== finalFrame && !enhancedFinal.isRecycled) enhancedFinal.recycle()
        }
        encodedFrames += 1
        frameSource.release(finalFrame)
        previous = null

        ensureNotCancelled(shouldCancel)
        onProgress(VideoAiStage.MUXING, 0.97, encodedFrames, encodedFrames)
        encoder.finish(shouldCancel)
        val outputUri = publishOutput(outputFile, request.displayName)
        onProgress(VideoAiStage.MUXING, 1.0, encodedFrames, encodedFrames)
        AiVideoExportResult(
          outputUri = outputUri,
          width = outputWidth,
          height = outputHeight,
          fps = outputFps,
          totalFrames = encodedFrames
        )
      } catch (error: Throwable) {
        encoder.abort()
        outputFile.delete()
        throw error
      } finally {
        previous?.let { frameSource.release(it) }
      }
    }
  }

  /**
   * 生成两帧之间的中间帧，并放大到输出尺寸。
   *
   * 这里做两级降级，是插帧质量与性能的关键：
   * 1. 两帧几乎一致（重复帧）时直接复用 [enhancedPrevious]（A 帧的超分结果），
   *    输出内容与复制前一帧完全一致，但省掉一次全尺寸 Real-ESRGAN 推理；
   * 2. 两帧差异过大（转场、剧烈运动）时同样复用 —— 这种情况下光流没有解，
   *    强行插值只会得到撕裂的鬼影；
   * 3. RIFE 返回 null（原生层判定光流未收敛）时也复用。
   *
   * 只有 RIFE 真正产出中间帧时才会额外跑一次超分。
   * 返回值可能与 [enhancedPrevious] 是同一实例，调用方据此判断是否回收。
   */
  private fun buildIntermediateFrame(
    previous: Bitmap,
    current: Bitmap,
    enhancedPrevious: Bitmap,
    request: VideoAiRequest,
    outputWidth: Int,
    outputHeight: Int,
    shouldCancel: () -> Boolean
  ): Bitmap {
    val motion = AiNativeEngine.motionScore(previous, current)
    val interpolatedBitmap = when {
      motion < 0.0 -> AiNativeEngine.interpolateOrNull(previous, current)
      motion < DUPLICATE_MOTION -> null
      motion > MAX_INTERPOLATABLE_MOTION -> null
      else -> AiNativeEngine.interpolateOrNull(previous, current)
    } ?: return enhancedPrevious
    return try {
      val enhanced = enhanceFrame(
        source = interpolatedBitmap,
        scale = request.scale,
        targetWidth = outputWidth,
        targetHeight = outputHeight,
        shouldCancel = shouldCancel
      )
      if (enhanced !== interpolatedBitmap && !interpolatedBitmap.isRecycled) {
        interpolatedBitmap.recycle()
      }
      enhanced
    } catch (error: Throwable) {
      if (!interpolatedBitmap.isRecycled) interpolatedBitmap.recycle()
      throw error
    }
  }

  private fun enhanceFrame(
    source: Bitmap,
    scale: Int,
    targetWidth: Int,
    targetHeight: Int,
    shouldCancel: () -> Boolean
  ): Bitmap {
    ensureNotCancelled(shouldCancel)
    // scale != 2 时不再整帧复制：尺寸已匹配就直接返回源帧本身，
    // 调用方以「结果 !== 源帧」来决定回收，源帧仍可安全归还帧池。
    val processed = if (scale == 2) {
      AiNativeEngine.upscale(source)
    } else {
      source
    }
    ensureNotCancelled(shouldCancel)
    if (processed.width == targetWidth && processed.height == targetHeight) return processed
    val resized = Bitmap.createScaledBitmap(processed, targetWidth, targetHeight, true)
    if (resized !== processed && processed !== source && !processed.isRecycled) processed.recycle()
    return resized
  }

  private fun outputFileFor(displayName: String): File {
    val safeName = displayName.replace(Regex("[\\\\/:*?\"<>|]"), "_").take(80).ifBlank { "AI 视频" }
    val directory = File(context.getExternalFilesDir(Environment.DIRECTORY_MOVIES), "夜映/AI").apply { mkdirs() }
    return File(directory, "${safeName}_AI_${System.currentTimeMillis()}.mp4")
  }

  private fun publishOutput(file: File, displayName: String): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      MediaScannerConnection.scanFile(context, arrayOf(file.absolutePath), arrayOf("video/mp4"), null)
      return Uri.fromFile(file).toString()
    }

    val safeName = displayName.replace(Regex("[\\\\/:*?\"<>|]"), "_").take(80).ifBlank { "AI 视频" }
    val values = ContentValues().apply {
      put(MediaStore.Video.Media.DISPLAY_NAME, "${safeName}_AI.mp4")
      put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
      put(MediaStore.Video.Media.RELATIVE_PATH, "${Environment.DIRECTORY_MOVIES}/夜映/AI")
      put(MediaStore.Video.Media.IS_PENDING, 1)
    }
    val resolver = context.contentResolver
    val uri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values)
      ?: throw IllegalStateException("无法创建媒体库输出文件")
    try {
      resolver.openOutputStream(uri, "w")?.use { output ->
        file.inputStream().use { input -> input.copyTo(output) }
      } ?: throw IllegalStateException("无法写入媒体库输出文件")
      resolver.update(uri, ContentValues().apply {
        put(MediaStore.Video.Media.IS_PENDING, 0)
      }, null, null)
      file.delete()
      return uri.toString()
    } catch (error: Throwable) {
      resolver.delete(uri, null, null)
      throw error
    }
  }

  private fun ensureNotCancelled(shouldCancel: () -> Boolean) {
    if (shouldCancel()) {
      AiNativeEngine.cancel()
      throw AiVideoExportCancelledException()
    }
  }

  private fun exportProgress(processed: Int, total: Int): Double =
    (0.05 + 0.9 * (processed.toDouble() / max(1, total))).coerceAtMost(0.95)

  private fun even(value: Int): Int = if (value % 2 == 0) value else value - 1

  companion object {
    private const val MAX_DURATION_US = 60_000_000L
    private const val MAX_OUTPUT_WIDTH = 3840
    private const val MAX_OUTPUT_HEIGHT = 2160
    private const val MAX_OUTPUT_FPS = 120.0
    private const val TILE_BALANCED = 256
    private const val TILE_QUALITY = 192
    /** 低于该值认为两帧是重复帧。 */
    private const val DUPLICATE_MOTION = 0.5
    /** 高于该值认为运动过大或存在转场，放弃插值。 */
    private const val MAX_INTERPOLATABLE_MOTION = 58.0

    internal fun setExtractorSource(extractor: MediaExtractor, context: Context, inputUri: String) {
      val uri = Uri.parse(inputUri)
      if (uri.scheme == "content") {
        extractor.setDataSource(context, uri, null)
      } else if (uri.scheme == "file") {
        extractor.setDataSource(uri.path ?: inputUri)
      } else {
        extractor.setDataSource(inputUri)
      }
    }
  }
}

/** 进度回调节流：每帧都写一次 SharedPreferences 会形成 I/O 风暴，明显拖慢导出。 */
private class ProgressThrottle(
  private val onProgress: (VideoAiStage, Double, Int, Int) -> Unit
) {
  private var lastReportAt = 0L

  fun report(stage: VideoAiStage, progress: Double, processed: Int, total: Int) {
    val now = System.currentTimeMillis()
    val important = progress <= 0.0 || progress >= 1.0
    if (!important && now - lastReportAt < MIN_INTERVAL_MS) return
    lastReportAt = now
    onProgress(stage, progress, processed, total)
  }

  private companion object {
    const val MIN_INTERVAL_MS = 400L
  }
}

private class H264Mp4Encoder(
  private val context: Context,
  inputUri: String,
  private val outputFile: File,
  private val width: Int,
  private val height: Int,
  fps: Double,
  private val preset: String,
  private val orientation: Int
) {
  private val encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
  private val muxer = MediaMuxer(outputFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
  private val bufferInfo = MediaCodec.BufferInfo()
  private val audioSource = AudioTrackSource(context, inputUri)
  private lateinit var inputSurface: EncoderInputSurface
  private var videoTrack = -1
  private var audioTrack = -1
  private var muxerStarted = false
  private var finished = false

  init {
    val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
      setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
      val bitsPerPixel = if (preset == "quality") 0.14 else 0.10
      setInteger(
        MediaFormat.KEY_BIT_RATE,
        (width * height * fps * bitsPerPixel).toLong().coerceIn(2_000_000L, 40_000_000L).toInt()
      )
      setInteger(MediaFormat.KEY_FRAME_RATE, fps.roundToLong().toInt())
      setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
    }
    encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    inputSurface = EncoderInputSurface(encoder.createInputSurface(), width, height)
    encoder.start()
  }

  fun writeFrame(bitmap: Bitmap, presentationTimeUs: Long) {
    check(!finished) { "编码器已经结束" }
    inputSurface.drawFrame(bitmap)
    inputSurface.setPresentationTime(presentationTimeUs * 1_000L)
    inputSurface.swapBuffers()
    drainEncoder(false)
  }

  fun finish(shouldCancel: () -> Boolean) {
    if (finished) return
    inputSurface.makeCurrent()
    encoder.signalEndOfInputStream()
    drainEncoder(true)
    if (shouldCancel()) throw AiVideoExportCancelledException()
    if (muxerStarted && audioTrack >= 0) audioSource.copyInto(muxer, audioTrack, shouldCancel)
    release()
    finished = true
  }

  fun abort() {
    if (!finished) release()
    finished = true
  }

  private fun drainEncoder(endOfStream: Boolean) {
    var outputEnded = false
    while (!outputEnded) {
      val outputIndex = encoder.dequeueOutputBuffer(bufferInfo, if (endOfStream) TIMEOUT_US else 0)
      when {
        outputIndex == MediaCodec.INFO_TRY_AGAIN_LATER -> {
          if (!endOfStream) return
        }
        outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          check(!muxerStarted) { "编码器输出格式重复变化" }
          videoTrack = muxer.addTrack(encoder.outputFormat)
          audioSource.format?.let { audioTrack = muxer.addTrack(it) }
          if (orientation != 0) muxer.setOrientationHint(orientation)
          muxer.start()
          muxerStarted = true
        }
        outputIndex >= 0 -> {
          val output = encoder.getOutputBuffer(outputIndex) ?: throw IllegalStateException("无法获取编码输出缓冲区")
          if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) bufferInfo.size = 0
          if (bufferInfo.size > 0) {
            check(muxerStarted) { "复用器尚未启动" }
            output.position(bufferInfo.offset)
            output.limit(bufferInfo.offset + bufferInfo.size)
            muxer.writeSampleData(videoTrack, output, bufferInfo)
          }
          encoder.releaseOutputBuffer(outputIndex, false)
          if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputEnded = true
        }
      }
    }
  }

  private fun release() {
    runCatching { audioSource.close() }
    runCatching { inputSurface.release() }
    runCatching { encoder.stop() }
    runCatching { encoder.release() }
    if (muxerStarted) runCatching { muxer.stop() }
    runCatching { muxer.release() }
  }

  companion object {
    private const val TIMEOUT_US = 10_000L
  }
}

private class EncoderInputSurface(
  private val surface: Surface,
  private val width: Int,
  private val height: Int
) {
  private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
  private var context: EGLContext = EGL14.EGL_NO_CONTEXT
  private var eglSurface: EGLSurface = EGL14.EGL_NO_SURFACE
  private lateinit var renderer: BitmapFrameRenderer

  init {
    display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
    check(display != EGL14.EGL_NO_DISPLAY) { "无法获取 EGL display" }
    val version = IntArray(2)
    check(EGL14.eglInitialize(display, version, 0, version, 1)) { "无法初始化 EGL" }

    val attributes = intArrayOf(
      EGL14.EGL_RED_SIZE, 8,
      EGL14.EGL_GREEN_SIZE, 8,
      EGL14.EGL_BLUE_SIZE, 8,
      EGL14.EGL_ALPHA_SIZE, 8,
      EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
      EGL_RECORDABLE_ANDROID, 1,
      EGL14.EGL_NONE
    )
    val configs = arrayOfNulls<EGLConfig>(1)
    val configCount = IntArray(1)
    check(EGL14.eglChooseConfig(display, attributes, 0, configs, 0, configs.size, configCount, 0)) {
      "无法选择 EGL config"
    }
    val config = configs[0] ?: throw IllegalStateException("没有可用的 EGL config")
    context = EGL14.eglCreateContext(
      display,
      config,
      EGL14.EGL_NO_CONTEXT,
      intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE),
      0
    )
    checkEgl("创建 EGL context")
    eglSurface = EGL14.eglCreateWindowSurface(display, config, surface, intArrayOf(EGL14.EGL_NONE), 0)
    checkEgl("创建编码 EGL surface")
    makeCurrent()
    renderer = BitmapFrameRenderer()
  }

  fun makeCurrent() {
    check(EGL14.eglMakeCurrent(display, eglSurface, eglSurface, context)) { "无法激活编码 EGL surface" }
  }

  fun drawFrame(bitmap: Bitmap) {
    require(bitmap.width == width && bitmap.height == height) { "AI 输出帧尺寸不匹配" }
    makeCurrent()
    renderer.draw(bitmap, width, height)
  }

  fun setPresentationTime(presentationTimeNs: Long) {
    EGLExt.eglPresentationTimeANDROID(display, eglSurface, presentationTimeNs)
  }

  fun swapBuffers() {
    check(EGL14.eglSwapBuffers(display, eglSurface)) { "编码帧提交失败" }
  }

  fun release() {
    if (::renderer.isInitialized) renderer.release()
    if (display != EGL14.EGL_NO_DISPLAY) {
      EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
      if (eglSurface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, eglSurface)
      if (context != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, context)
      EGL14.eglReleaseThread()
      EGL14.eglTerminate(display)
    }
    surface.release()
    display = EGL14.EGL_NO_DISPLAY
    context = EGL14.EGL_NO_CONTEXT
    eglSurface = EGL14.EGL_NO_SURFACE
  }

  private fun checkEgl(action: String) {
    check(EGL14.eglGetError() == EGL14.EGL_SUCCESS) { "$action 失败" }
  }

  companion object {
    private const val EGL_RECORDABLE_ANDROID = 0x3142
  }
}

private class BitmapFrameRenderer {
  private val vertexBuffer = floatBuffer(floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f))
  private val textureBuffer = floatBuffer(floatArrayOf(0f, 1f, 1f, 1f, 0f, 0f, 1f, 0f))
  private val program = createProgram(VERTEX_SHADER, FRAGMENT_SHADER)
  private val positionHandle = GLES20.glGetAttribLocation(program, "aPosition")
  private val textureHandle = GLES20.glGetAttribLocation(program, "aTexCoord")
  private val samplerHandle = GLES20.glGetUniformLocation(program, "uTexture")
  private val textureId = IntArray(1)
  private var textureWidth = 0
  private var textureHeight = 0

  init {
    GLES20.glGenTextures(1, textureId, 0)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, textureId[0])
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
  }

  fun draw(bitmap: Bitmap, width: Int, height: Int) {
    GLES20.glViewport(0, 0, width, height)
    GLES20.glClearColor(0f, 0f, 0f, 1f)
    GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
    GLES20.glUseProgram(program)
    GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, textureId[0])
    // 只有首帧或尺寸变化时才重建纹理存储，其余帧复用已分配的显存
    if (bitmap.width != textureWidth || bitmap.height != textureHeight) {
      GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bitmap, 0)
      textureWidth = bitmap.width
      textureHeight = bitmap.height
    } else {
      GLUtils.texSubImage2D(GLES20.GL_TEXTURE_2D, 0, 0, 0, bitmap)
    }
    GLES20.glUniform1i(samplerHandle, 0)

    vertexBuffer.position(0)
    textureBuffer.position(0)
    GLES20.glEnableVertexAttribArray(positionHandle)
    GLES20.glVertexAttribPointer(positionHandle, 2, GLES20.GL_FLOAT, false, 0, vertexBuffer)
    GLES20.glEnableVertexAttribArray(textureHandle)
    GLES20.glVertexAttribPointer(textureHandle, 2, GLES20.GL_FLOAT, false, 0, textureBuffer)
    GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
    GLES20.glDisableVertexAttribArray(positionHandle)
    GLES20.glDisableVertexAttribArray(textureHandle)
  }

  fun release() {
    GLES20.glDeleteTextures(1, textureId, 0)
    GLES20.glDeleteProgram(program)
  }

  private fun createProgram(vertexSource: String, fragmentSource: String): Int {
    val vertex = compileShader(GLES20.GL_VERTEX_SHADER, vertexSource)
    val fragment = compileShader(GLES20.GL_FRAGMENT_SHADER, fragmentSource)
    return GLES20.glCreateProgram().also { program ->
      GLES20.glAttachShader(program, vertex)
      GLES20.glAttachShader(program, fragment)
      GLES20.glLinkProgram(program)
      val linkStatus = IntArray(1)
      GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, linkStatus, 0)
      check(linkStatus[0] == GLES20.GL_TRUE) { "无法链接编码着色器" }
      GLES20.glDeleteShader(vertex)
      GLES20.glDeleteShader(fragment)
    }
  }

  private fun compileShader(type: Int, source: String): Int = GLES20.glCreateShader(type).also { shader ->
    GLES20.glShaderSource(shader, source)
    GLES20.glCompileShader(shader)
    val compiled = IntArray(1)
    GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, compiled, 0)
    check(compiled[0] == GLES20.GL_TRUE) { "无法编译编码着色器" }
  }

  companion object {
    private const val VERTEX_SHADER = """
      attribute vec4 aPosition;
      attribute vec2 aTexCoord;
      varying vec2 vTexCoord;
      void main() {
        gl_Position = aPosition;
        vTexCoord = aTexCoord;
      }
    """
    private const val FRAGMENT_SHADER = """
      precision mediump float;
      varying vec2 vTexCoord;
      uniform sampler2D uTexture;
      void main() {
        gl_FragColor = texture2D(uTexture, vTexCoord);
      }
    """
  }
}

private fun floatBuffer(values: FloatArray): FloatBuffer =
  ByteBuffer.allocateDirect(values.size * Float.SIZE_BYTES)
    .order(ByteOrder.nativeOrder())
    .asFloatBuffer()
    .apply {
      put(values)
      position(0)
    }

private class AudioTrackSource(context: Context, inputUri: String) {
  private val extractor = MediaExtractor()
  private var trackIndex = -1
  var format: MediaFormat? = null
    private set

  init {
    runCatching {
      AiVideoExportPipeline.setExtractorSource(extractor, context, inputUri)
      trackIndex = (0 until extractor.trackCount).firstOrNull { index ->
        extractor.getTrackFormat(index).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
      } ?: -1
      if (trackIndex >= 0) format = extractor.getTrackFormat(trackIndex)
    }.onFailure {
      trackIndex = -1
      format = null
    }
  }

  fun copyInto(muxer: MediaMuxer, muxerTrack: Int, shouldCancel: () -> Boolean) {
    if (trackIndex < 0) return
    extractor.selectTrack(trackIndex)
    val size = format
      ?.takeIf { it.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE) }
      ?.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE)
      ?.coerceIn(64 * 1024, 2 * 1024 * 1024)
      ?: 256 * 1024
    val buffer = ByteBuffer.allocateDirect(size)
    val info = MediaCodec.BufferInfo()
    while (true) {
      if (shouldCancel()) throw AiVideoExportCancelledException()
      buffer.clear()
      info.offset = 0
      info.size = extractor.readSampleData(buffer, 0)
      if (info.size < 0) break
      info.presentationTimeUs = extractor.sampleTime
      info.flags = if (extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) {
        MediaCodec.BUFFER_FLAG_KEY_FRAME
      } else {
        0
      }
      muxer.writeSampleData(muxerTrack, buffer, info)
      if (!extractor.advance()) break
    }
  }

  fun close() {
    extractor.release()
  }
}
