package expo.modules.videoai

import android.content.Context
import android.content.ContentValues
import android.graphics.Bitmap
import android.graphics.Color
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Environment
import android.os.Build
import android.provider.MediaStore
import java.io.File
import java.nio.ByteBuffer
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

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
    val probe = probe(request.inputUri)
    require(probe.width > 0 && probe.height > 0) { "无法读取视频分辨率" }
    require(probe.durationUs > 0) { "无法读取视频时长" }
    require(probe.width * probe.height <= MAX_INPUT_PIXELS) {
      "首版 AI 导出仅支持 720p 及以下输入视频"
    }
    require(probe.durationUs <= MAX_DURATION_US) {
      "首版 AI 导出仅支持 60 秒以内的视频"
    }

    val modelRoot = AiModelInstaller.ensure(context)
    if (!AiNativeEngine.initialize(modelRoot.absolutePath)) {
      throw IllegalStateException(
        AiNativeEngine.lastError().ifBlank { "无法初始化 Real-ESRGAN / RIFE 模型" }
      )
    }

    val sourceFrameDurationUs = max(1L, (1_000_000.0 / probe.fps).toLong())
    val sourceFrames = max(1, ceil(probe.durationUs.toDouble() / sourceFrameDurationUs).toInt())
    val outputFrames = if (request.interpolation == "x2") {
      max(1, sourceFrames * 2 - 1)
    } else {
      sourceFrames
    }
    val outputFps = min(if (request.interpolation == "x2") probe.fps * 2 else probe.fps, 60.0)
    val outputFrameDurationUs = max(1L, (1_000_000.0 / outputFps).toLong())

    val retriever = MediaMetadataRetriever()
    setRetrieverSource(retriever, context, request.inputUri)
    val first = frameAt(retriever, 0)
    val outputWidth = even(if (request.scale == 2) first.width * 2 else first.width)
    val outputHeight = even(if (request.scale == 2) first.height * 2 else first.height)
    require(outputWidth <= MAX_OUTPUT_WIDTH && outputHeight <= MAX_OUTPUT_HEIGHT) {
      "输出分辨率超过 ${MAX_OUTPUT_WIDTH}x${MAX_OUTPUT_HEIGHT} 限制"
    }

    val outputFile = outputFileFor(request.displayName)
    val encoder = H264Mp4Encoder(
      context,
      request.inputUri,
      outputFile,
      outputWidth,
      outputHeight,
      outputFps,
      request.preset
    )
    var previous: Bitmap? = first
    var encodedFrames = 0

    try {
      onProgress(VideoAiStage.PREPARING, 0.02, 0, outputFrames)
      for (frameIndex in 1 until sourceFrames) {
        ensureNotCancelled(shouldCancel)
        val current = frameAt(retriever, frameIndex * sourceFrameDurationUs)
        val previousFrame = previous ?: throw IllegalStateException("缺少前一帧")

        val enhancedPrevious = enhanceFrame(previousFrame, request.scale, outputWidth, outputHeight, shouldCancel)
        encoder.writeFrame(enhancedPrevious, encodedFrames * outputFrameDurationUs)
        recycleIfOwned(enhancedPrevious, previousFrame)
        encodedFrames += 1
        onProgress(
          VideoAiStage.UPSCALING,
          exportProgress(encodedFrames, outputFrames),
          encodedFrames,
          outputFrames
        )

        if (request.interpolation == "x2") {
          ensureNotCancelled(shouldCancel)
          onProgress(
            VideoAiStage.INTERPOLATING,
            exportProgress(encodedFrames, outputFrames),
            encodedFrames,
            outputFrames
          )
          val intermediate = if (isLikelySceneCut(previousFrame, current)) {
            previousFrame.copy(Bitmap.Config.ARGB_8888, false)
          } else {
            AiNativeEngine.interpolate(previousFrame, current)
          }
          val enhancedIntermediate = enhanceFrame(intermediate, request.scale, outputWidth, outputHeight, shouldCancel)
          encoder.writeFrame(enhancedIntermediate, encodedFrames * outputFrameDurationUs)
          recycleIfOwned(enhancedIntermediate, intermediate)
          if (intermediate !== previousFrame && !intermediate.isRecycled) intermediate.recycle()
          encodedFrames += 1
          onProgress(
            VideoAiStage.UPSCALING,
            exportProgress(encodedFrames, outputFrames),
            encodedFrames,
            outputFrames
          )
        }

        if (!previousFrame.isRecycled) previousFrame.recycle()
        previous = current
      }

      val finalFrame = previous ?: throw IllegalStateException("无法读取视频帧")
      val enhancedFinal = enhanceFrame(finalFrame, request.scale, outputWidth, outputHeight, shouldCancel)
      encoder.writeFrame(enhancedFinal, encodedFrames * outputFrameDurationUs)
      recycleIfOwned(enhancedFinal, finalFrame)
      if (!finalFrame.isRecycled) finalFrame.recycle()
      previous = null
      encodedFrames += 1

      ensureNotCancelled(shouldCancel)
      onProgress(VideoAiStage.MUXING, 0.97, encodedFrames, outputFrames)
      encoder.finish(shouldCancel)
      val outputUri = publishOutput(outputFile, request.displayName)
      onProgress(VideoAiStage.MUXING, 1.0, encodedFrames, outputFrames)
      return AiVideoExportResult(
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
      previous?.takeIf { !it.isRecycled }?.recycle()
      retriever.release()
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
    val processed = if (scale == 2) AiNativeEngine.upscale(source) else source.copy(Bitmap.Config.ARGB_8888, false)
    ensureNotCancelled(shouldCancel)
    if (processed.width == targetWidth && processed.height == targetHeight) return processed
    val resized = Bitmap.createScaledBitmap(processed, targetWidth, targetHeight, true)
    if (resized !== processed && !processed.isRecycled) processed.recycle()
    return resized
  }

  private fun probe(inputUri: String): VideoProbe {
    val retriever = MediaMetadataRetriever()
    return try {
      setRetrieverSource(retriever, context, inputUri)
      val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
      val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
      val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
      val metadataFps = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE)
        ?.toDoubleOrNull()
      VideoProbe(width, height, durationMs * 1_000L, (metadataFps ?: extractorFps(inputUri)).coerceIn(12.0, 30.0))
    } finally {
      retriever.release()
    }
  }

  private fun extractorFps(inputUri: String): Double {
    val extractor = MediaExtractor()
    return try {
      setExtractorSource(extractor, context, inputUri)
      (0 until extractor.trackCount)
        .map { extractor.getTrackFormat(it) }
        .firstOrNull { it.getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true }
        ?.let { format ->
          if (format.containsKey(MediaFormat.KEY_FRAME_RATE)) format.getInteger(MediaFormat.KEY_FRAME_RATE).toDouble() else 30.0
        }
        ?.takeIf { it > 0 } ?: 30.0
    } finally {
      extractor.release()
    }
  }

  private fun frameAt(retriever: MediaMetadataRetriever, timeUs: Long): Bitmap {
    val frame = retriever.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST)
      ?: throw IllegalStateException("无法解码视频帧")
    return if (frame.config == Bitmap.Config.ARGB_8888) frame else frame.copy(Bitmap.Config.ARGB_8888, false).also { frame.recycle() }
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

  private fun isLikelySceneCut(first: Bitmap, second: Bitmap): Boolean {
    var delta = 0L
    var samples = 0
    for (row in 1..8) {
      val y = (first.height - 1) * row / 9
      for (column in 1..8) {
        val x = (first.width - 1) * column / 9
        val firstColor = first.getPixel(x, y)
        val secondColor = second.getPixel(min(x, second.width - 1), min(y, second.height - 1))
        delta += kotlin.math.abs(Color.red(firstColor) - Color.red(secondColor))
        delta += kotlin.math.abs(Color.green(firstColor) - Color.green(secondColor))
        delta += kotlin.math.abs(Color.blue(firstColor) - Color.blue(secondColor))
        samples += 3
      }
    }
    return delta.toDouble() / samples > 58.0
  }

  private fun recycleIfOwned(bitmap: Bitmap, source: Bitmap) {
    if (bitmap !== source && !bitmap.isRecycled) bitmap.recycle()
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

  private data class VideoProbe(val width: Int, val height: Int, val durationUs: Long, val fps: Double)

  companion object {
    private const val MAX_INPUT_PIXELS = 1280 * 720
    private const val MAX_DURATION_US = 60_000_000L
    private const val MAX_OUTPUT_WIDTH = 2560
    private const val MAX_OUTPUT_HEIGHT = 1440

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

    internal fun setRetrieverSource(retriever: MediaMetadataRetriever, context: Context, inputUri: String) {
      val uri = Uri.parse(inputUri)
      if (uri.scheme == "content") {
        retriever.setDataSource(context, uri)
      } else if (uri.scheme == "file") {
        retriever.setDataSource(uri.path ?: inputUri)
      } else {
        retriever.setDataSource(inputUri)
      }
    }
  }
}

private class H264Mp4Encoder(
  private val context: Context,
  inputUri: String,
  private val outputFile: File,
  private val width: Int,
  private val height: Int,
  private val fps: Double,
  private val preset: String
) {
  private val codecInfo = findEncoder()
  private val colorFormat = chooseColorFormat(codecInfo)
  private val encoder = MediaCodec.createByCodecName(codecInfo.name)
  private val muxer = MediaMuxer(outputFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
  private val bufferInfo = MediaCodec.BufferInfo()
  private val audioSource = AudioTrackSource(context, inputUri)
  private var videoTrack = -1
  private var audioTrack = -1
  private var muxerStarted = false
  private var finished = false

  init {
    val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
      setInteger(MediaFormat.KEY_COLOR_FORMAT, colorFormat)
      val qualityMultiplier = if (preset == "quality") 1.45 else 1.0
      setInteger(
        MediaFormat.KEY_BIT_RATE,
        (width * height * fps * 0.12 * qualityMultiplier).toInt().coerceIn(2_000_000, 24_000_000)
      )
      setInteger(MediaFormat.KEY_FRAME_RATE, fps.toInt())
      setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
    }
    encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    encoder.start()
  }

  fun writeFrame(bitmap: Bitmap, presentationTimeUs: Long) {
    check(!finished) { "编码器已经结束" }
    var inputIndex = encoder.dequeueInputBuffer(TIMEOUT_US)
    while (inputIndex < 0) {
      drainEncoder(false)
      inputIndex = encoder.dequeueInputBuffer(TIMEOUT_US)
    }
    val input = encoder.getInputBuffer(inputIndex) ?: throw IllegalStateException("无法获取编码输入缓冲区")
    input.clear()
    fillYuvBuffer(bitmap, input)
    encoder.queueInputBuffer(inputIndex, 0, width * height * 3 / 2, presentationTimeUs, 0)
    drainEncoder(false)
  }

  fun finish(shouldCancel: () -> Boolean) {
    if (finished) return
    var inputIndex = encoder.dequeueInputBuffer(TIMEOUT_US)
    while (inputIndex < 0) {
      drainEncoder(false)
      inputIndex = encoder.dequeueInputBuffer(TIMEOUT_US)
    }
    encoder.queueInputBuffer(inputIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
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

  private fun fillYuvBuffer(bitmap: Bitmap, output: ByteBuffer) {
    require(bitmap.width == width && bitmap.height == height) { "AI 输出帧尺寸不匹配" }
    val pixels = IntArray(width * height)
    bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
    for (pixel in pixels) output.put(luma(pixel).toByte())
    if (colorFormat == MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Planar) {
      for (component in 0..1) {
        for (y in 0 until height step 2) {
          for (x in 0 until width step 2) {
            val chroma = chroma(pixels, x, y)
            output.put(if (component == 0) chroma.first.toByte() else chroma.second.toByte())
          }
        }
      }
    } else {
      for (y in 0 until height step 2) {
        for (x in 0 until width step 2) {
          val chroma = chroma(pixels, x, y)
          output.put(chroma.first.toByte())
          output.put(chroma.second.toByte())
        }
      }
    }
  }

  private fun luma(color: Int): Int =
    ((66 * Color.red(color) + 129 * Color.green(color) + 25 * Color.blue(color) + 128) shr 8) + 16

  private fun chroma(pixels: IntArray, x: Int, y: Int): Pair<Int, Int> {
    var red = 0
    var green = 0
    var blue = 0
    for (offsetY in 0..1) {
      for (offsetX in 0..1) {
        val color = pixels[(y + offsetY) * width + x + offsetX]
        red += Color.red(color)
        green += Color.green(color)
        blue += Color.blue(color)
      }
    }
    red /= 4
    green /= 4
    blue /= 4
    val u = (((-38 * red - 74 * green + 112 * blue + 128) shr 8) + 128).coerceIn(0, 255)
    val v = (((112 * red - 94 * green - 18 * blue + 128) shr 8) + 128).coerceIn(0, 255)
    return u to v
  }

  private fun release() {
    runCatching { audioSource.close() }
    runCatching { encoder.stop() }
    runCatching { encoder.release() }
    if (muxerStarted) runCatching { muxer.stop() }
    runCatching { muxer.release() }
  }

  private fun findEncoder(): MediaCodecInfo {
    val codecs = MediaCodecList(MediaCodecList.ALL_CODECS).codecInfos
    return codecs.firstOrNull { info ->
      info.isEncoder && MediaFormat.MIMETYPE_VIDEO_AVC in info.supportedTypes && runCatching {
        chooseColorFormat(info) != -1
      }.getOrDefault(false)
    } ?: throw IllegalStateException("设备不支持兼容的 H.264 编码器")
  }

  private fun chooseColorFormat(info: MediaCodecInfo): Int {
    val formats = info.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC).colorFormats
    return when {
      formats.contains(MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420SemiPlanar) ->
        MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420SemiPlanar
      formats.contains(MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Planar) ->
        MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Planar
      else -> -1
    }
  }

  companion object {
    private const val TIMEOUT_US = 10_000L
  }
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
