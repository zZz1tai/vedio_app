package expo.modules.videoai

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

internal enum class VideoAiStage {
  QUEUED,
  PREPARING,
  INTERPOLATING,
  UPSCALING,
  MUXING,
  COMPLETED,
  FAILED,
  CANCELLED;

  fun value() = name.lowercase()

  companion object {
    fun from(value: String?) = entries.firstOrNull { it.value() == value } ?: QUEUED
  }
}

internal data class VideoAiRequest(
  val inputUri: String,
  val displayName: String,
  val scale: Int,
  val interpolation: String,
  val preset: String
) {
  companion object {
    fun fromMap(values: Map<String, Any?>): VideoAiRequest {
      val inputUri = values["inputUri"]?.toString()?.trim().orEmpty()
      require(inputUri.isNotBlank()) { "缺少输入视频地址" }
      val scale = (values["scale"] as? Number)?.toInt()?.takeIf { it == 1 || it == 2 } ?: 2
      val interpolation = values["interpolation"]?.toString()?.takeIf { it == "off" || it == "x2" } ?: "x2"
      val preset = values["preset"]?.toString()?.takeIf { it == "balanced" || it == "quality" } ?: "balanced"
      val displayName = values["displayName"]?.toString()?.trim().takeUnless { it.isNullOrBlank() }
        ?: "AI 导出视频"
      return VideoAiRequest(inputUri, displayName, scale, interpolation, preset)
    }
  }
}

internal data class VideoAiJob(
  val id: String,
  val request: VideoAiRequest,
  val stage: VideoAiStage,
  val progress: Double,
  val processedFrames: Int,
  val totalFrames: Int,
  val outputUri: String? = null,
  val outputWidth: Int? = null,
  val outputHeight: Int? = null,
  val outputFps: Double? = null,
  val errorMessage: String? = null,
  val createdAt: Long,
  val updatedAt: Long
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "id" to id,
    "inputUri" to request.inputUri,
    "displayName" to request.displayName,
    "scale" to request.scale,
    "interpolation" to request.interpolation,
    "preset" to request.preset,
    "stage" to stage.value(),
    "progress" to progress,
    "processedFrames" to processedFrames,
    "totalFrames" to totalFrames,
    "outputUri" to outputUri,
    "outputWidth" to outputWidth,
    "outputHeight" to outputHeight,
    "outputFps" to outputFps,
    "errorMessage" to errorMessage,
    "createdAt" to createdAt.toDouble(),
    "updatedAt" to updatedAt.toDouble()
  )

  fun toJson(): JSONObject = JSONObject().apply {
    put("id", id)
    put("inputUri", request.inputUri)
    put("displayName", request.displayName)
    put("scale", request.scale)
    put("interpolation", request.interpolation)
    put("preset", request.preset)
    put("stage", stage.value())
    put("progress", progress)
    put("processedFrames", processedFrames)
    put("totalFrames", totalFrames)
    put("outputUri", outputUri)
    put("outputWidth", outputWidth)
    put("outputHeight", outputHeight)
    put("outputFps", outputFps)
    put("errorMessage", errorMessage)
    put("createdAt", createdAt)
    put("updatedAt", updatedAt)
  }

  companion object {
    fun new(request: VideoAiRequest): VideoAiJob {
      val now = System.currentTimeMillis()
      return VideoAiJob(
        id = UUID.randomUUID().toString(),
        request = request,
        stage = VideoAiStage.QUEUED,
        progress = 0.0,
        processedFrames = 0,
        totalFrames = 0,
        createdAt = now,
        updatedAt = now
      )
    }

    fun fromJson(json: JSONObject): VideoAiJob {
      val request = VideoAiRequest(
        inputUri = json.optString("inputUri"),
        displayName = json.optString("displayName", "AI 导出视频"),
        scale = json.optInt("scale", 2),
        interpolation = json.optString("interpolation", "x2"),
        preset = json.optString("preset", "balanced")
      )
      return VideoAiJob(
        id = json.getString("id"),
        request = request,
        stage = VideoAiStage.from(json.optString("stage")),
        progress = json.optDouble("progress", 0.0),
        processedFrames = json.optInt("processedFrames", 0),
        totalFrames = json.optInt("totalFrames", 0),
        outputUri = json.optString("outputUri").takeIf { it.isNotBlank() && it != "null" },
        outputWidth = json.optInt("outputWidth", -1).takeIf { it > 0 },
        outputHeight = json.optInt("outputHeight", -1).takeIf { it > 0 },
        outputFps = json.optDouble("outputFps", -1.0).takeIf { it > 0 },
        errorMessage = json.optString("errorMessage").takeIf { it.isNotBlank() && it != "null" },
        createdAt = json.optLong("createdAt", System.currentTimeMillis()),
        updatedAt = json.optLong("updatedAt", System.currentTimeMillis())
      )
    }
  }
}

internal class VideoAiJobStore(context: Context) {
  private val preferences = context.getSharedPreferences("expo-video-ai.jobs", Context.MODE_PRIVATE)
  private val lock = Any()

  fun get(id: String): VideoAiJob? = synchronized(lock) {
    preferences.getString("job:$id", null)?.let { raw ->
      runCatching { VideoAiJob.fromJson(JSONObject(raw)) }.getOrNull()
    }
  }

  fun list(): List<VideoAiJob> = synchronized(lock) {
    val ids = runCatching { JSONArray(preferences.getString("ids", "[]")) }.getOrDefault(JSONArray())
    buildList {
      for (index in 0 until ids.length()) {
        get(ids.optString(index))?.let(::add)
      }
    }.sortedByDescending { it.updatedAt }
  }

  fun save(job: VideoAiJob) = synchronized(lock) {
    val ids = runCatching { JSONArray(preferences.getString("ids", "[]")) }.getOrDefault(JSONArray())
    val exists = (0 until ids.length()).any { ids.optString(it) == job.id }
    if (!exists) ids.put(job.id)
    preferences.edit()
      .putString("ids", ids.toString())
      .putString("job:${job.id}", job.toJson().toString())
      .apply()
    job
  }

  fun update(id: String, transform: (VideoAiJob) -> VideoAiJob): VideoAiJob? = synchronized(lock) {
    val current = get(id) ?: return@synchronized null
    save(transform(current).copy(updatedAt = System.currentTimeMillis()))
  }
}

internal object AiModelInstaller {
  private const val VERSION = "v1"
  private const val MARKER = ".ready"
  private val assets = listOf(
    "ai-models/realesrgan_x2plus.param",
    "ai-models/realesrgan_x2plus.bin",
    "ai-models/rife-v4.6/flownet.param",
    "ai-models/rife-v4.6/flownet.bin"
  )

  @Synchronized
  fun ensure(context: Context): File {
    val root = File(context.filesDir, "video-ai-models/$VERSION")
    if (File(root, MARKER).isFile) return root
    root.deleteRecursively()
    root.mkdirs()
    for (asset in assets) {
      val target = File(root, asset.removePrefix("ai-models/"))
      target.parentFile?.mkdirs()
      context.assets.open(asset).use { input ->
        FileOutputStream(target).use(input::copyTo)
      }
    }
    File(root, MARKER).writeText(VERSION)
    return root
  }
}
