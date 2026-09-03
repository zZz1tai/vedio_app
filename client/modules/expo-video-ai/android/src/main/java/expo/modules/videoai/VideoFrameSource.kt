package expo.modules.videoai

import android.content.Context
import android.graphics.Bitmap
import android.media.Image
import android.media.MediaCodec
import android.media.MediaCodec.BufferInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import java.io.Closeable
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal data class VideoProbeInfo(
  val width: Int,
  val height: Int,
  val durationUs: Long,
  val fps: Double,
  val rotation: Int,
  val frameCount: Int
)

/**
 * 顺序、逐帧的视频解码源。
 *
 * 之前的实现用 MediaMetadataRetriever.getFrameAtTime(OPTION_CLOSEST) 逐帧取样，
 * 该 API 在 Android 上只保证「尽力接近」目标时间，大量设备实际返回的是最近的关键帧。
 * 超分辨率是逐帧独立运算，取样不精确只会表现为跳帧，画面仍然干净；
 * 而插帧强依赖相邻两帧之间的时间连续性，一旦相邻两次取样实际相隔一个甚至数个 GOP，
 * RIFE 的光流会彻底失效，直接产出全屏鬼影与撕裂 —— 这正是「超分可用、插帧必炸」的原因。
 *
 * 这里改用 MediaExtractor + MediaCodec 顺序解码：
 * - 帧序严格按解码顺序递增，不会重复也不会回跳
 * - 帧率由真实 sample 时间戳的中位数推算，不再依赖不可靠的元数据
 * - 解码在后台线程进行，与 AI 推理流水线化
 * - Bitmap 池化复用，避免每帧分配
 *
 * 输出采用 ByteBuffer 直出模式（configure 不挂 Surface），通过
 * MediaCodec.getOutputImage() 拿 YUV_420_888 的 Image 再转 Bitmap。
 * 之前走 Surface + ImageReader 路径，在 HyperOS/Android 16 上
 * SurfaceImage.getPlanes() 会因底层缓冲指针为空触发 native SIGABRT
 * （NewDirectByteBuffer 空指针），且无法被 Java 捕获，只能绕开该路径。
 */
internal class VideoFrameSource private constructor(
  private val extractor: MediaExtractor,
  private val codec: MediaCodec,
  val probe: VideoProbeInfo
) : Closeable {
  private val width = probe.width
  private val height = probe.height
  private val endMarker = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
  private val frames = ArrayBlockingQueue<Bitmap>(FRAME_QUEUE_CAPACITY)
  private val pool = ConcurrentLinkedQueue<Bitmap>()
  private val closed = AtomicBoolean(false)
  private val failure = AtomicReference<Throwable?>(null)
  private lateinit var decoderThread: Thread

  init {
    codec.start()
    decoderThread = Thread(Runnable { decodeLoop() }, "video-ai-decoder").apply {
      isDaemon = true
      start()
    }
  }

  /** 阻塞取下一帧；到达片尾返回 null。 */
  fun next(): Bitmap? {
    val frame = frames.take()
    if (frame !== endMarker) return frame
    // 保持 EOS 标记在队列里，后续调用一律返回 null
    frames.put(endMarker)
    failure.get()?.let { throw IllegalStateException("视频解码失败：${it.message}", it) }
    return null
  }

  /**
   * 有界投递：消费端（AI 推理）停滞时定期醒来检查关闭标记，
   * 保证 close() 时解码线程不会永远卡在 put 上，能及时汇合退出。
   */
  private fun offerFrame(frame: Bitmap): Boolean {
    while (!closed.get()) {
      if (frames.offer(frame, OFFER_INTERVAL_MS, TimeUnit.MILLISECONDS)) return true
    }
    return false
  }

  /** 把用过的帧还给复用池。 */
  fun release(frame: Bitmap) {
    if (frame !== endMarker && frame.width == width && frame.height == height) {
      pool.offer(frame)
    }
  }

  private fun acquire(): Bitmap =
    pool.poll() ?: Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)

  private fun decodeLoop() {
    val info = BufferInfo()
    var inputEos = false
    var outputEos = false
    var consecutiveConversionFailures = 0
    try {
      while (!outputEos && !closed.get()) {
        if (consecutiveConversionFailures >= MAX_CONSECUTIVE_DECODE_FAILURES) {
          failure.compareAndSet(
            null,
            IllegalStateException("解码器输出的 YUV 数据无法读取（当前设备色彩格式不受支持）")
          )
          break
        }
        if (!inputEos) {
          val inputIndex = codec.dequeueInputBuffer(DEQUEUE_TIMEOUT_US)
          if (inputIndex >= 0) {
            val buffer = codec.getInputBuffer(inputIndex)
            if (buffer == null) {
              codec.queueInputBuffer(inputIndex, 0, 0, 0L, 0)
            } else {
              val size = extractor.readSampleData(buffer, 0)
              if (size < 0) {
                codec.queueInputBuffer(
                  inputIndex, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM
                )
                inputEos = true
              } else {
                val flags = if (extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) {
                  MediaCodec.BUFFER_FLAG_KEY_FRAME
                } else {
                  0
                }
                codec.queueInputBuffer(inputIndex, 0, size, extractor.sampleTime, flags)
                extractor.advance()
              }
            }
          }
        }

        when (val outputIndex = codec.dequeueOutputBuffer(info, DEQUEUE_TIMEOUT_US)) {
          MediaCodec.INFO_TRY_AGAIN_LATER -> Unit
          MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED -> Unit
          MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> Unit
          else -> {
            if (outputIndex < 0) continue
            val hasFrame = info.size > 0 &&
              (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0)
            if (hasFrame && !closed.get()) {
              // ByteBuffer 直出模式：先从输出缓冲里取 Image 并转换，
              // 转换完成后才能 releaseOutputBuffer 归还缓冲。
              // getOutputImage 返回 null 表示该缓冲不含视频帧，直接跳过。
              val image = runCatching { codec.getOutputImage(outputIndex) }.getOrNull()
              if (image != null) {
                try {
                  val target = acquire()
                  if (!closed.get() && AiNativeEngine.yuvToBitmap(image, target) &&
                    offerFrame(target)
                  ) {
                    consecutiveConversionFailures = 0
                  } else {
                    pool.offer(target)
                    consecutiveConversionFailures += 1
                  }
                } finally {
                  image.close()
                }
              } else {
                consecutiveConversionFailures += 1
              }
            }
            codec.releaseOutputBuffer(outputIndex, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputEos = true
          }
        }
      }
    } catch (interrupted: InterruptedException) {
      // close() 触发的正常退出
    } catch (cancelled: RuntimeException) {
      if (!closed.get()) failure.compareAndSet(null, cancelled)
    } catch (error: Throwable) {
      failure.compareAndSet(null, error)
    } finally {
      // 正常结束或 close() 后都要让消费者能从 next() 解除阻塞；
      // 关闭路径下循环条件立刻不成立，直接跳过
      while (!closed.get()) {
        if (frames.offer(endMarker, OFFER_INTERVAL_MS, TimeUnit.MILLISECONDS)) break
      }
    }
  }

  override fun close() {
    if (!closed.compareAndSet(false, true)) return
    runCatching { decoderThread.interrupt() }
    // 必须先等解码线程退出，再释放 codec。
    // 否则解码线程可能还在读取输出缓冲，codec 被并发释放会触发 native abort。
    runCatching { decoderThread.join(JOIN_TIMEOUT_MS) }
    runCatching { codec.stop() }
    runCatching { codec.release() }
    runCatching { extractor.release() }
    while (true) {
      val queued = frames.poll() ?: break
      if (queued !== endMarker && !queued.isRecycled) queued.recycle()
    }
    while (true) {
      val pooled = pool.poll() ?: break
      if (!pooled.isRecycled) pooled.recycle()
    }
    if (!endMarker.isRecycled) endMarker.recycle()
  }

  internal companion object {
    private const val FRAME_QUEUE_CAPACITY = 2
    private const val DEQUEUE_TIMEOUT_US = 10_000L
    private const val OFFER_INTERVAL_MS = 250L
    private const val JOIN_TIMEOUT_MS = 3_000L
    private const val MAX_CONSECUTIVE_DECODE_FAILURES = 30
    private const val MIN_FPS = 12.0
    private const val MAX_FPS = 120.0
    private const val FPS_SAMPLE_LIMIT = 512

    fun open(context: Context, inputUri: String): VideoFrameSource {
      val extractor = MediaExtractor()
      var codec: MediaCodec? = null
      try {
        AiVideoExportPipeline.setExtractorSource(extractor, context, inputUri)
        val trackIndex = (0 until extractor.trackCount).firstOrNull { index ->
          extractor.getTrackFormat(index)
            .getString(MediaFormat.KEY_MIME)
            ?.startsWith("video/") == true
        } ?: throw IllegalStateException("视频文件没有可用的视频轨道")
        val format = extractor.getTrackFormat(trackIndex)

        val (rawWidth, rawHeight) = decodeSize(format)
        val width = even(rawWidth)
        val height = even(rawHeight)
        require(width > 0 && height > 0) { "无法读取视频分辨率" }

        val durationUs = if (format.containsKey(MediaFormat.KEY_DURATION)) {
          format.getLong(MediaFormat.KEY_DURATION)
        } else {
          0L
        }
        require(durationUs > 0) { "无法读取视频时长" }

        val analysis = analyzeTrack(extractor, trackIndex, durationUs)
        val metadataFps = if (format.containsKey(MediaFormat.KEY_FRAME_RATE)) {
          format.getInteger(MediaFormat.KEY_FRAME_RATE).toDouble().takeIf { it > 0 }
        } else {
          null
        }
        val fps = (analysis.first ?: metadataFps ?: 30.0).coerceIn(MIN_FPS, MAX_FPS)
        val rotation = runCatching { format.getInteger(MediaFormat.KEY_ROTATION) }.getOrDefault(0)

        val probe = VideoProbeInfo(
          width = width,
          height = height,
          durationUs = durationUs,
          fps = fps,
          rotation = rotation,
          frameCount = analysis.second
        )

        extractor.selectTrack(trackIndex)
        extractor.seekTo(0, MediaExtractor.SEEK_TO_CLOSEST_SYNC)

        val decoder = MediaCodec.createDecoderByType(
          format.getString(MediaFormat.KEY_MIME) ?: MediaFormat.MIMETYPE_VIDEO_AVC
        )
        codec = decoder
        // ByteBuffer 直出模式（不挂 Surface）：YUV 帧通过 getOutputImage() 获取，
        // 不经过 ImageReader/BufferQueue，规避部分系统上 getPlanes() 的 native abort
        decoder.configure(format, null, null, 0)
        return VideoFrameSource(extractor, decoder, probe)
      } catch (error: Throwable) {
        runCatching { codec?.release() }
        runCatching { extractor.release() }
        throw error
      }
    }

    /**
     * 返回 (帧率; 总帧数)。
     *
     * 不能直接用 sampleTime 相邻差值算帧率：MediaExtractor 是按解码顺序遍历的，
     * 有 B 帧时时间戳并非单调递增（例如 0 → 125 → 41.7 → 83.3），
     * 负差值被过滤后剩下的正差值被严重高估，中位数算出的帧率会偏小。
     * 实测一段 24fps 视频被算成 12fps，导致插帧后输出帧率只有 24fps、
     * 成片时长翻倍且整体变慢。
     *
     * 改用两种与解码顺序无关的算法：
     * 1. 帧数 / 时长：只用容器里的精确时长与帧数，最可靠，作为基准
     * 2. 排序后相邻时间戳差值的中位数：对恒定帧率视频等于真实帧间隔
     * 两者相差超过 25% 时以「帧数 / 时长」为准。
     */
    private fun analyzeTrack(
      extractor: MediaExtractor,
      trackIndex: Int,
      durationUs: Long
    ): Pair<Double?, Int> {
      extractor.selectTrack(trackIndex)
      extractor.seekTo(0, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
      val timestamps = ArrayList<Long>()
      while (true) {
        val pts = extractor.sampleTime
        if (pts < 0) break
        timestamps.add(pts)
        if (!extractor.advance()) break
      }
      extractor.seekTo(0, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
      val count = timestamps.size

      // 算法 1：帧数 / 时长
      val durationFps = if (durationUs > 0 && count > 1) {
        count * 1_000_000.0 / durationUs.toDouble()
      } else {
        null
      }

      // 算法 2：排序后相邻时间戳差值的中位数
      val medianFps = if (count > 1) {
        timestamps.sort()
        val deltas = ArrayList<Long>(FPS_SAMPLE_LIMIT)
        for (index in 1 until timestamps.size) {
          if (deltas.size >= FPS_SAMPLE_LIMIT) break
          val delta = timestamps[index] - timestamps[index - 1]
          if (delta > 0 && delta < 1_000_000L) deltas.add(delta)
        }
        if (deltas.isEmpty()) {
          null
        } else {
          deltas.sort()
          1_000_000.0 / deltas[deltas.size / 2]
        }
      } else {
        null
      }

      val fps = when {
        durationFps == null -> medianFps
        medianFps == null -> durationFps
        kotlin.math.abs(medianFps - durationFps) > durationFps * 0.25 -> durationFps
        else -> medianFps
      }
      return Pair(fps, count)
    }

    private fun decodeSize(format: MediaFormat): Pair<Int, Int> {
      val hasCrop = format.containsKey("crop-left") && format.containsKey("crop-right") &&
        format.containsKey("crop-top") && format.containsKey("crop-bottom")
      val width = if (hasCrop) {
        format.getInteger("crop-right") - format.getInteger("crop-left") + 1
      } else {
        format.getInteger(MediaFormat.KEY_WIDTH)
      }
      val height = if (hasCrop) {
        format.getInteger("crop-bottom") - format.getInteger("crop-top") + 1
      } else {
        format.getInteger(MediaFormat.KEY_HEIGHT)
      }
      return Pair(width, height)
    }

    private fun even(value: Int): Int = if (value % 2 == 0) value else value - 1
  }
}
