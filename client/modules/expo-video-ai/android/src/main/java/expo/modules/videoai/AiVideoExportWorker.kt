package expo.modules.videoai

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.ForegroundInfo
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

class AiVideoExportWorker(
  appContext: Context,
  parameters: WorkerParameters
) : Worker(appContext, parameters) {
  override fun doWork(): Result {
    val jobId = inputData.getString(JOB_ID_KEY) ?: return Result.failure()
    val store = VideoAiJobStore(applicationContext)
    val job = store.get(jobId) ?: return Result.failure()
    if (job.stage == VideoAiStage.CANCELLED) return Result.success()

    return try {
      setForegroundAsync(createForegroundInfo(job.request.displayName)).get(15, TimeUnit.SECONDS)
      val pipeline = AiVideoExportPipeline(applicationContext)
      val result = pipeline.export(
        request = job.request,
        shouldCancel = { isStopped || store.get(jobId)?.stage == VideoAiStage.CANCELLED },
        onProgress = { stage, progress, processed, total ->
          store.update(jobId) { current ->
            current.copy(
              stage = stage,
              progress = progress,
              processedFrames = processed,
              totalFrames = total,
              errorMessage = null
            )
          }
          setProgressAsync(
            androidx.work.workDataOf(
              "stage" to stage.value(),
              "progress" to progress,
              "processedFrames" to processed,
              "totalFrames" to total
            )
          )
        }
      )
      store.update(jobId) { current ->
        current.copy(
          stage = VideoAiStage.COMPLETED,
          progress = 1.0,
          processedFrames = result.totalFrames,
          totalFrames = result.totalFrames,
          outputUri = result.outputUri,
          outputWidth = result.width,
          outputHeight = result.height,
          outputFps = result.fps,
          errorMessage = null
        )
      }
      Result.success()
    } catch (cancelled: AiVideoExportCancelledException) {
      store.update(jobId) { current ->
        current.copy(stage = VideoAiStage.CANCELLED, errorMessage = null)
      }
      Result.success()
    } catch (error: Throwable) {
      store.update(jobId) { current ->
        current.copy(
          stage = VideoAiStage.FAILED,
          errorMessage = error.message ?: "AI 导出失败"
        )
      }
      Result.failure()
    } finally {
      AiNativeEngine.close()
    }
  }

  private fun createForegroundInfo(title: String): ForegroundInfo {
    val notificationManager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      notificationManager.createNotificationChannel(
        NotificationChannel(
          CHANNEL_ID,
          "AI 视频导出",
          NotificationManager.IMPORTANCE_LOW
        )
      )
    }
    val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setContentTitle("正在导出 AI 视频")
      .setContentText(title)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setProgress(100, 0, true)
      .build()
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ForegroundInfo(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
      )
    } else {
      ForegroundInfo(NOTIFICATION_ID, notification)
    }
  }

  companion object {
    const val JOB_ID_KEY = "jobId"
    const val WORK_NAME = "expo-video-ai.export"
    const val WORK_TAG = "expo-video-ai"
    private const val CHANNEL_ID = "expo-video-ai-export"
    private const val NOTIFICATION_ID = 7301
  }
}
