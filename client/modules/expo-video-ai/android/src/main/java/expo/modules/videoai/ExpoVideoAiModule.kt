package expo.modules.videoai

import android.content.Context
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ExpoVideoAiModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoVideoAi")

    Function("isAvailable") {
      AiNativeEngine.isSupported()
    }

    AsyncFunction("enqueue") { values: Map<String, Any?> ->
      val context = appContext.reactContext?.applicationContext
        ?: throw IllegalStateException("应用上下文不可用")
      val request = VideoAiRequest.fromMap(values)
      val store = VideoAiJobStore(context)
      val existing = store.list().firstOrNull {
        it.stage !in setOf(VideoAiStage.COMPLETED, VideoAiStage.FAILED, VideoAiStage.CANCELLED)
      }
      require(existing == null) { "已有一个 AI 导出任务正在运行" }
      require(AiNativeEngine.isSupported()) { "此设备不支持 Vulkan AI 导出" }

      val job = store.save(VideoAiJob.new(request))
      val work = OneTimeWorkRequestBuilder<AiVideoExportWorker>()
        .setInputData(workDataOf(AiVideoExportWorker.JOB_ID_KEY to job.id))
        .addTag(AiVideoExportWorker.WORK_TAG)
        .build()
      WorkManager.getInstance(context).enqueueUniqueWork(
        AiVideoExportWorker.WORK_NAME,
        ExistingWorkPolicy.KEEP,
        work
      )
      job.toMap()
    }

    AsyncFunction("getJob") { id: String ->
      val context = appContext.reactContext?.applicationContext
      context?.let { VideoAiJobStore(it).get(id)?.toMap() }
    }

    AsyncFunction("listJobs") {
      val context = appContext.reactContext?.applicationContext
      context?.let { VideoAiJobStore(it).list().map(VideoAiJob::toMap) }
        ?: emptyList<Map<String, Any?>>()
    }

    AsyncFunction("cancel") { id: String ->
      val context = appContext.reactContext?.applicationContext
        ?: throw IllegalStateException("应用上下文不可用")
      val job = VideoAiJobStore(context).update(id) { current ->
        current.copy(stage = VideoAiStage.CANCELLED, errorMessage = null)
      }
      AiNativeEngine.cancel()
      WorkManager.getInstance(context).cancelUniqueWork(AiVideoExportWorker.WORK_NAME)
      job?.toMap()
    }

    AsyncFunction("upscaleImage") { values: Map<String, Any?> ->
      val context = appContext.reactContext?.applicationContext
        ?: throw IllegalStateException("应用上下文不可用")
      val inputUri = values["inputUri"]?.toString()?.trim().orEmpty()
      require(inputUri.isNotBlank()) { "缺少图片地址" }
      val scale = (values["scale"] as? Number)?.toInt()?.takeIf { it == 2 || it == 4 } ?: 4
      // 返回 Map 而非自定义 data class：Expo Modules 桥只支持 Map/List/基本类型序列化，
      // 直接返回 AiImageUpscaleResult 会抛 "Unknown type" 序列化异常
      val result = AiImageUpscalePipeline(context).upscale(inputUri, scale, onProgress = { })
      mapOf(
        "outputUri" to result.outputUri,
        "width" to result.width,
        "height" to result.height,
      )
    }
  }
}
