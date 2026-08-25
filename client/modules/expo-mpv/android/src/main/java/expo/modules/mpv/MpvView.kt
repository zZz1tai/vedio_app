package expo.modules.mpv

import android.content.Context
import android.net.Uri
import android.util.Log
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import `is`.xyz.mpv.MPV
import `is`.xyz.mpv.MPVNode
import java.io.File

/**
 * libmpv 渲染视图。libmpv 在进程内是全局单例，同一时刻只允许一个 MpvView 挂载。
 * 视图挂载时创建/初始化 mpv，卸载时销毁。
 */
class MpvView(context: Context, appContext: AppContext) : ExpoView(context, appContext),
  SurfaceHolder.Callback {

  companion object {
    private const val TAG = "ExpoMpv"
    private const val MPV_EVENT_FILE_LOADED = 8
    private const val MPV_EVENT_END_FILE = 7
    private const val MPV_END_FILE_REASON_ERROR = 4
    private const val MPV_FORMAT_FLAG = 3
    private const val MPV_FORMAT_INT64 = 4
    private const val MPV_FORMAT_DOUBLE = 5
    private const val PROGRESS_INTERVAL_MS = 250L
    private const val ERROR_INTERVAL_MS = 1500L

    private val SHADER_ASSET_NAMES = listOf(
      "Anime4K_Clamp_Highlights.glsl",
      "Anime4K_Restore_CNN_S.glsl",
      "Anime4K_Restore_CNN_M.glsl",
      "Anime4K_Restore_CNN_L.glsl",
      "Anime4K_Upscale_CNN_x2_S.glsl",
      "Anime4K_Upscale_CNN_x2_M.glsl",
      "Anime4K_Upscale_CNN_x2_L.glsl",
      "Anime4K_AutoDownscalePre_x2.glsl",
      "Anime4K_AutoDownscalePre_x4.glsl"
    )

    @Volatile
    private var mpvInstance: MPV? = null

    /**
     * 懒加载 MPV 实例。禁止在类初始化（<clinit>）阶段构造：
     * 一旦 System.loadLibrary 首次失败，类会被永久标记为初始化失败，
     * 之后所有引用都抛 NoClassDefFoundError。放到这里失败可被捕获并降级。
     */
    private fun lib(): MPV {
      mpvInstance?.let { return it }
      synchronized(this) {
        mpvInstance?.let { return it }
        return MPV().also { mpvInstance = it }
      }
    }

    @Volatile
    private var libInitialized = false

    @Volatile
    private var activeView: MpvView? = null

    /** 供模块级函数调用：路由到当前挂载的视图实例 */
    fun seekActive(positionMs: Double) {
      activeView?.seekTo(positionMs)
    }
  }

  private val surfaceView = SurfaceView(context)

  val onLoad by EventDispatcher<Map<String, Any>>()
  val onProgress by EventDispatcher<Map<String, Any>>()
  val onPlayingChange by EventDispatcher<Map<String, Any>>()
  val onEnded by EventDispatcher<Map<String, Any>>()
  val onDimensions by EventDispatcher<Map<String, Any>>()
  val onError by EventDispatcher<Map<String, Any>>()

  private var pendingUri: String? = null
  private var loadedUri: String? = null
  private var surfaceReady = false
  private var lastProgressSentAt = 0L
  private var lastErrorSentAt = 0L
  private var endedNotified = false
  private var sentDimensions = false

  // 初始化前的期望状态，初始化完成后统一应用
  private var desiredPaused = false
  private var desiredRate = 1.0f
  private var desiredVolume = 1.0f
  private var desiredMuted = false
  private var desiredResizeMode: String? = null
  private var desiredEnhancement: String? = "off"

  init {
    addView(
      surfaceView,
      FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT
      )
    )
    surfaceView.holder.addCallback(this)
  }

  // region 生命周期

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    activeView = this
    ensureInitialized()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    if (activeView === this) {
      activeView = null
      destroyLibrary()
    }
  }

  override fun surfaceCreated(holder: SurfaceHolder) {
    if (!libInitialized) return
    lib().attachSurface(holder.surface)
    lib().setOptionString("force-window", "yes")
    surfaceReady = true
    maybeLoadPendingUri()
  }

  override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
    if (!libInitialized) return
    lib().setPropertyString("android-surface-size", "${width}x$height")
  }

  override fun surfaceDestroyed(holder: SurfaceHolder) {
    surfaceReady = false
    if (!libInitialized) return
    lib().setPropertyString("vo", "null")
    lib().setOptionString("force-window", "no")
    lib().detachSurface()
  }

  // endregion

  // region 初始化 / 销毁

  private fun ensureInitialized() {
    synchronized(MpvView::class.java) {
      if (libInitialized) return
      try {
        lib().create(context.applicationContext)
        applyDefaultOptions()
        lib().init()
        // observe_property 必须在 mpv core 初始化之后调用才会生效
        observeProperties()
        lib().addObserver(sharedObserver)
        lib().addLogObserver(object : MPV.LogObserver {
          override fun logMessage(prefix: String, level: Int, text: String) {
            Log.d("mpv", "[$level] $prefix: $text")
          }
        })
        libInitialized = true
        Log.i(TAG, "libmpv initialized")
      } catch (t: Throwable) {
        Log.e(TAG, "libmpv init failed", t)
        dispatchError("init失败 ${t.javaClass.simpleName}: ${t.message}")
        return
      }
    }
    applyPendingState()
  }

  private fun destroyLibrary() {
    synchronized(MpvView::class.java) {
      if (!libInitialized) return
      try { lib().removeObserver(sharedObserver) } catch (_: Throwable) {}
      try { lib().command(*arrayOf("stop")) } catch (_: Throwable) {}
      try { lib().destroy() } catch (_: Throwable) {}
      mpvInstance = null
      libInitialized = false
      loadedUri = null
      surfaceReady = false
    }
  }

  private fun applyDefaultOptions() {
    lib().setOptionString("config", "no")
    lib().setOptionString("vo", "gpu")
    lib().setOptionString("gpu-context", "android")
    // copy 模式：帧经过 GL 管线，glsl-shaders（Anime4K）才会生效
    lib().setOptionString("hwdec", "mediacodec")
    lib().setOptionString("ao", "audiotrack")
    lib().setOptionString("keep-open", "always")
    lib().setOptionString("idle", "yes")
    lib().setOptionString("force-window", "no")
    lib().setOptionString("osc", "no")
    lib().setOptionString("input-default-bindings", "no")
    lib().setOptionString("ytdl", "no")
    lib().setOptionString("cache", "yes")
    lib().setOptionString("demuxer-readahead-secs", "20")
    // content:// 转成的 fd://<fd> 播放完由 mpv 负责关闭
    lib().setOptionString("fd-close", "yes")
    val cacheDir = File(context.cacheDir, "mpv_cache").apply { mkdirs() }.absolutePath
    lib().setOptionString("gpu-shader-cache-dir", cacheDir)
    lib().setOptionString("icc-cache-dir", cacheDir)
  }

  private fun observeProperties() {
    lib().observeProperty("time-pos", MPV_FORMAT_DOUBLE)
    lib().observeProperty("duration", MPV_FORMAT_DOUBLE)
    lib().observeProperty("pause", MPV_FORMAT_FLAG)
    lib().observeProperty("eof-reached", MPV_FORMAT_FLAG)
    lib().observeProperty("width", MPV_FORMAT_INT64)
    lib().observeProperty("height", MPV_FORMAT_INT64)
  }

  private fun applyPendingState() {
    post {
      if (!libInitialized) return@post
      applyPausedInternal(desiredPaused)
      applyRateInternal(desiredRate)
      applyVolumeInternal(desiredVolume)
      applyMutedInternal(desiredMuted)
      applyResizeMode(desiredResizeMode ?: "contain")
      applyEnhancement(desiredEnhancement ?: "off")
      maybeLoadPendingUri()
    }
  }

  // endregion

  // region 属性（由 JS 设置）

  fun setUri(uri: String?) {
    val next = resolveSource(uri) ?: return
    if (next == pendingUri) return
    pendingUri = next
    maybeLoadPendingUri()
  }

  /**
   * 归一化成 mpv 能直接打开的形式：
   * - file://：解码百分号编码得到真实路径（ffmpeg 不做 URL 解码，
   *   中文/空格文件名若不处理会 ENOENT）
   * - content://：转成 fd://<fd> 交给 mpv（配合 init 时设置 fd-close=yes）
   * - 其余（http/https/绝对路径）原样透传
   */
  private fun resolveSource(raw: String?): String? {
    val trimmed = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    return runCatching {
      when {
        trimmed.startsWith("file://", ignoreCase = true) ->
          Uri.parse(trimmed).path?.takeIf { it.isNotBlank() } ?: trimmed
        trimmed.startsWith("content://", ignoreCase = true) -> openContentFd(trimmed) ?: trimmed
        else -> trimmed
      }
    }.getOrNull() ?: trimmed
  }

  private fun openContentFd(contentUri: String): String? {
    val pfd = context.contentResolver.openFileDescriptor(Uri.parse(contentUri), "r") ?: return null
    val fd = pfd.detachFd()
    return "fd://$fd"
  }

  fun applyPaused(paused: Boolean) {
    desiredPaused = paused
    if (!libInitialized) return
    applyPausedInternal(paused)
  }

  fun applyRate(rate: Float) {
    desiredRate = rate
    if (!libInitialized || rate <= 0f) return
    applyRateInternal(rate)
  }

  fun applyVolume(volume: Float) {
    desiredVolume = volume
    if (!libInitialized) return
    applyVolumeInternal(volume)
  }

  fun applyMuted(muted: Boolean) {
    desiredMuted = muted
    if (!libInitialized) return
    applyMutedInternal(muted)
  }

  fun applyResizeMode(mode: String?) {
    desiredResizeMode = mode
    if (!libInitialized) return
    applyResizeModeInternal(mode ?: "contain")
  }

  fun applyEnhancement(level: String?) {
    desiredEnhancement = level
    if (!libInitialized) return
    applyEnhancementInternal(level ?: "off")
  }

  fun seekTo(positionMs: Double) {
    if (!libInitialized) return
    val seconds = (positionMs / 1000.0).coerceAtLeast(0.0).toString()
    lib().command(*arrayOf("seek", seconds, "absolute+exact"))
  }

  private fun applyPausedInternal(paused: Boolean) = runCatching {
    lib().setPropertyBoolean("pause", paused)
  }

  private fun applyRateInternal(rate: Float) = runCatching {
    lib().setPropertyDouble("speed", rate.toDouble())
  }

  private fun applyVolumeInternal(volume: Float) = runCatching {
    lib().setPropertyDouble("volume", (volume * 100.0).coerceIn(0.0, 100.0))
  }

  private fun applyMutedInternal(muted: Boolean) = runCatching {
    lib().setPropertyBoolean("mute", muted)
  }

  private fun applyResizeModeInternal(mode: String) = runCatching {
    when (mode) {
      "stretch" -> {
        lib().setPropertyBoolean("keepaspect", false)
        lib().setPropertyDouble("panscan", 0.0)
      }
      "cover" -> {
        lib().setPropertyBoolean("keepaspect", true)
        lib().setPropertyDouble("panscan", 1.0)
      }
      else -> {
        lib().setPropertyBoolean("keepaspect", true)
        lib().setPropertyDouble("panscan", 0.0)
      }
    }
  }

  private fun applyEnhancementInternal(level: String) = runCatching {
    val paths = shaderPathsFor(level)
    // mpv 列表选项的分隔符是英文逗号，不能用分号（否则整个串被当成一个路径）
    lib().command(*arrayOf("change-list", "glsl-shaders", "set", paths.joinToString(",")))
    val applied = runCatching { lib().getPropertyString("glsl-shaders") }.getOrNull()
    Log.i(TAG, "enhancement=$level glsl-shaders -> $applied")
  }

  // endregion

  // region Anime4K shader

  private fun ensureShadersCopied(): File {
    val outDir = File(File(context.filesDir, "shaders"), "anime4k")
    outDir.mkdirs()
    for (name in SHADER_ASSET_NAMES) {
      val target = File(outDir, name)
      if (target.exists() && target.length() > 0L) continue
      context.assets.open("shaders/anime4k/$name").use { input ->
        target.outputStream().use { output -> input.copyTo(output) }
      }
    }
    return outDir
  }

  private fun shaderPathsFor(level: String): List<String> {
    if (level == "off") return emptyList()
    val dir = ensureShadersCopied()
    val names = when (level) {
      // 轻量：仅修复线条，不放大
      "low" -> listOf(
        "Anime4K_Clamp_Highlights.glsl",
        "Anime4K_Restore_CNN_S.glsl"
      )
      // 均衡：官方 Mode A (Fast)
      "medium" -> listOf(
        "Anime4K_Clamp_Highlights.glsl",
        "Anime4K_Restore_CNN_M.glsl",
        "Anime4K_Upscale_CNN_x2_M.glsl",
        "Anime4K_AutoDownscalePre_x2.glsl",
        "Anime4K_AutoDownscalePre_x4.glsl",
        "Anime4K_Upscale_CNN_x2_S.glsl"
      )
      // 高：官方 Mode A (HQ)，VL 换成 L 控制功耗
      "high" -> listOf(
        "Anime4K_Clamp_Highlights.glsl",
        "Anime4K_Restore_CNN_L.glsl",
        "Anime4K_Upscale_CNN_x2_M.glsl",
        "Anime4K_AutoDownscalePre_x2.glsl",
        "Anime4K_AutoDownscalePre_x4.glsl",
        "Anime4K_Upscale_CNN_x2_S.glsl"
      )
      else -> emptyList()
    }
    return names.map { File(dir, it).absolutePath }
  }

  // endregion

  // region 加载与事件分发

  private fun maybeLoadPendingUri() {
    val uri = pendingUri ?: return
    if (!libInitialized || !surfaceReady || uri == loadedUri) return
    endedNotified = false
    sentDimensions = false
    Log.d(TAG, "loadfile: $uri")
    lib().command(*arrayOf("loadfile", uri))
    loadedUri = uri
  }

  private val sharedObserver = object : MPV.EventObserver {
    override fun eventProperty(property: String) {}

    override fun eventProperty(property: String, value: Long) {
      if (property != "width" && property != "height") return
      post {
        if (activeView !== this@MpvView) return@post
        when (property) {
          "width" -> videoWidth = value.toInt()
          "height" -> videoHeight = value.toInt()
        }
        notifyDimensionsIfNeeded()
      }
    }

    override fun eventProperty(property: String, value: Boolean) {
      when (property) {
        "pause" -> post {
          if (activeView === this@MpvView) {
            onPlayingChange(mapOf("playing" to !value))
          }
        }
        "eof-reached" -> if (value) post {
          if (activeView === this@MpvView && !endedNotified) {
            endedNotified = true
            onPlayingChange(mapOf("playing" to false))
            onEnded(emptyMap())
          }
        }
      }
    }

    override fun eventProperty(property: String, value: String) {}

    override fun eventProperty(property: String, value: Double) {
      when (property) {
        "duration" -> post {
          if (activeView !== this@MpvView) return@post
          cachedDuration = value
        }
        "time-pos" -> post {
          if (activeView !== this@MpvView) return@post
          val now = System.currentTimeMillis()
          if (now - lastProgressSentAt < PROGRESS_INTERVAL_MS) return@post
          lastProgressSentAt = now
          onProgress(
            mapOf(
              "positionMs" to (value * 1000.0).toLong(),
              "durationMs" to (cachedDuration * 1000.0).toLong()
            )
          )
        }
      }
    }

    override fun eventProperty(property: String, value: MPVNode) {}

    override fun event(eventId: Int, node: MPVNode) {
      when (eventId) {
        MPV_EVENT_FILE_LOADED -> post {
          if (activeView !== this@MpvView) return@post
          val duration = runCatching { lib().getPropertyDouble("duration") }.getOrNull() ?: 0.0
          cachedDuration = duration
          onLoad(
            mapOf(
              "durationMs" to (duration * 1000.0).toLong(),
              "width" to videoWidth,
              "height" to videoHeight
            )
          )
          notifyDimensionsIfNeeded()
        }
        MPV_EVENT_END_FILE -> {
          val args = runCatching { node.asMap() }.getOrNull()
          val reason = args?.get("reason")?.asInt()?.toInt()
          val fileError = args?.get("file_error")?.asInt()?.toInt()
          Log.w(TAG, "end-file reason=$reason file_error=$fileError")
          if (reason == MPV_END_FILE_REASON_ERROR) post {
            if (activeView === this@MpvView) {
              dispatchError(
                if (fileError != null) "解码失败(file_error=$fileError)" else "播放失败(reason=error)"
              )
            }
          }
        }
      }
    }
  }

  private var cachedDuration = 0.0
  private var videoWidth = 0
  private var videoHeight = 0

  private fun notifyDimensionsIfNeeded() {
    if (sentDimensions || videoWidth <= 0 || videoHeight <= 0) return
    sentDimensions = true
    onDimensions(mapOf("width" to videoWidth, "height" to videoHeight))
  }

  private fun dispatchError(message: String) {
    val now = System.currentTimeMillis()
    if (now - lastErrorSentAt < ERROR_INTERVAL_MS) return
    lastErrorSentAt = now
    onError(mapOf("message" to message))
  }

  // endregion
}
