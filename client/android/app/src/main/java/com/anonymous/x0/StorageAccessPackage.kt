package com.anonymous.x0

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.SystemClock
import android.util.Log
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentSkipListSet
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

class StorageAccessModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "StorageAccess"

    // 模块销毁标记：Activity 销毁（小米墓碑等场景进程保留）/JS 重载后置位，
    // 长任务据此静默退出——绝不回调已销毁的 bridge（回调会触发 RN C++ FATAL abort）
    @Volatile private var destroyed = false

    // 扫描单线程串行（避免并发遍历抢占 IO 预算）；缩略图解码 2 并发（thumbInProgress 去重保证不重复解码），
    // 预热吞吐翻倍、未命中占位更快被填充；全部 daemon，不阻止进程退出
    private val scanExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "StorageAccess-scan").apply { isDaemon = true }
    }
    private val thumbExecutor = Executors.newFixedThreadPool(2) { r ->
        Thread(r, "StorageAccess-thumb").apply { isDaemon = true }
    }
    private val thumbFailedUris = ConcurrentSkipListSet<String>()
    private val thumbInProgress = ConcurrentHashMap.newKeySet<String>()
    private val thumbCleanupCounter = AtomicLong(0)

    /** bridge 是否仍然可用（未销毁且有活跃 RN 实例） */
    private fun bridgeAlive(): Boolean = !destroyed && reactContext.hasActiveReactInstance()

    /**
     * 事件通道（唯一与 JS 通信的方式）。
     * 弃用 Callback/Promise 参数的原因：RN 0.81 bridgeless（新架构）下，
     * 老式 @ReactMethod 的 Callback/Promise 在调用时（即使已切回 JS 线程）
     * 会触发 C++ LogMessageFatal abort（interop 层缺陷）；事件发射是官方
     * 支持的跨线程通道，本 app 的 onThumbnailReady 已大量实战验证安全。
     */
    private fun emit(event: String, payload: WritableMap) {
        if (!bridgeAlive()) return
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(event, payload)
        } catch (error: Throwable) {
            Log.w(TAG, "emit $event failed", error)
        }
    }

    /** RN 实例销毁（Activity finish / 进程重载）：立即置位并停掉后台线程池 */
    override fun onCatalystInstanceDestroy() {
        destroyed = true
        scanExecutor.shutdownNow()
        thumbExecutor.shutdownNow()
        super.onCatalystInstanceDestroy()
    }

    companion object {
        private const val TAG = "StorageAccess"
        private const val PRIMARY_STORAGE_ROOT = "/storage/emulated/0"
        private const val THUMB_DIR = "media_thumbs"
        private const val THUMB_CACHE_LIMIT_BYTES = 300L * 1024 * 1024
        private const val THUMB_CACHE_TARGET_BYTES = 150L * 1024 * 1024
        private const val THUMB_CLEANUP_EVERY = 200L
        private val SKIP_DIR_NAMES =
            setOf(
                "android",
                "lost.dir",
                "\$recycle.bin",
                "system volume information",
                "alldata_backup",
                "miui_backup",
                "backup",
                "download_backup"
            )
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun isAllFilesAccessGranted(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            true
        }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun renameFile(sourceUri: String, targetUri: String): Boolean {
        return try {
            val source = File(toRealPath(sourceUri))
            val target = File(toRealPath(targetUri))
            if (!source.isFile || target.exists()) {
                return false
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Files.move(source.toPath(), target.toPath())
            } else {
                if (!source.renameTo(target)) {
                    return false
                }
            }
            true
        } catch (error: Throwable) {
            Log.w(TAG, "renameFile failed", error)
            false
        }
    }

    /**
     * 全盘扫描（native 化，事件驱动）：BFS 遍历主存储，IO 与遍历在 native 线程执行，
     * JS 线程零阻塞。语义与原 JS 版本对齐：深度上限、跳过目录、结果上限、时间预算。
     *
     * 不用 Callback/Promise 参数：RN 0.81 bridgeless 下它们会触发 C++ FATAL abort
     * （三份小米 tombstone 实证）。进度/完成/失败一律经事件通道上报，
     * scanId 由 JS 生成，用于区分并发扫描与丢弃过期结果。
     */
    @ReactMethod
    fun scanMediaFiles(
        extensions: ReadableArray,
        maxDepth: Int,
        maxResults: Int,
        timeBudgetMs: Double,
        progressEvery: Int,
        scanId: String
    ) {
        val exts = HashSet<String>()
        for (i in 0 until extensions.size()) {
            extensions.getString(i)?.let { exts.add(it.lowercase()) }
        }
        scanExecutor.execute {
            val results: WritableArray = Arguments.createArray()
            var count = 0
            var lastProgress = 0
            val startedAt = SystemClock.elapsedRealtime()
            val budget = timeBudgetMs.toLong()
            try {
                val queue = ArrayDeque<Pair<File, Int>>()
                queue.addLast(File(PRIMARY_STORAGE_ROOT) to 0)
                while (queue.isNotEmpty()) {
                    if (!bridgeAlive()) break
                    if (count >= maxResults) break
                    if (SystemClock.elapsedRealtime() - startedAt > budget) break
                    val (dir, depth) = queue.removeFirst()
                    val entries = dir.listFiles() ?: continue
                    for (entry in entries) {
                        if (!bridgeAlive()) break
                        if (count >= maxResults) break
                        if (SystemClock.elapsedRealtime() - startedAt > budget) break
                        val lowerName = entry.name.lowercase()
                        if (entry.isDirectory) {
                            if (depth >= maxDepth) continue
                            if (lowerName in SKIP_DIR_NAMES || lowerName.startsWith(".")) continue
                            queue.addLast(entry to depth + 1)
                            continue
                        }
                        if (!entry.isFile) continue
                        val ext = lowerName.substringAfterLast('.', "")
                        if (ext.isEmpty() || ".$ext" !in exts) continue
                        val item = Arguments.createMap()
                        item.putString("uri", "file://" + Uri.encode(entry.absolutePath, "/"))
                        item.putString("filename", entry.name)
                        item.putDouble("size", entry.length().toDouble())
                        item.putDouble("modificationTime", entry.lastModified().toDouble())
                        results.pushMap(item)
                        count++
                        if (progressEvery > 0 && count - lastProgress >= progressEvery) {
                            lastProgress = count
                            if (!bridgeAlive()) break
                            emit(
                                "mediaScanProgress",
                                Arguments.createMap().apply {
                                    putString("scanId", scanId)
                                    putDouble("count", count.toDouble())
                                }
                            )
                        }
                    }
                }
                if (!bridgeAlive()) {
                    Log.i(TAG, "scan aborted: bridge destroyed (found $count files)")
                } else {
                    emit(
                        "mediaScanDone",
                        Arguments.createMap().apply {
                            putString("scanId", scanId)
                            putArray("data", results)
                        }
                    )
                }
            } catch (error: Throwable) {
                Log.w(TAG, "scanMediaFiles failed", error)
                if (bridgeAlive()) {
                    emit(
                        "mediaScanError",
                        Arguments.createMap().apply {
                            putString("scanId", scanId)
                            putString("message", error.message ?: "scan failed")
                        }
                    )
                }
            }
        }
    }

    /**
     * 取缩略图（同步方法、非阻塞语义）：
     * - 命中缓存：直接返回 file:// 缩略图路径
     * - 未命中：投递后台解码任务后返回 null（JS 先用原图占位，
     *   生成完成通过 onThumbnailReady 事件通知刷新）
     * - 不可解码类型（svg 等）记入失败集合，后续直接返回 null 不再重试
     */
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getThumbnail(sourceUri: String, targetSize: Int): String? {
        val cacheFile = thumbCacheFile(sourceUri, targetSize) ?: return null
        if (cacheFile.isFile && cacheFile.length() > 0) {
            return "file://" + cacheFile.absolutePath
        }
        if (thumbFailedUris.contains(sourceUri)) return null
        if (thumbInProgress.add(sourceUri)) {
            thumbExecutor.execute {
                if (destroyed) return@execute
                try {
                    decodeToThumbnail(sourceUri, cacheFile, targetSize)
                    emitThumbnailReady(sourceUri)
                } catch (error: Throwable) {
                    thumbFailedUris.add(sourceUri)
                    cacheFile.delete()
                    Log.w(TAG, "thumbnail decode failed: $sourceUri", error)
                } finally {
                    thumbInProgress.remove(sourceUri)
                }
            }
            maybeCleanupThumbCache()
        }
        return null
    }

    /** 批量预热：扫描完成后调用，后台串行解码，命中缓存的自动跳过（fire and forget，无返回） */
    @ReactMethod
    fun prepareThumbnails(sources: ReadableArray, targetSize: Double) {
        val size = targetSize.toInt().coerceAtLeast(128)
        val uris = ArrayList<String>(sources.size())
        for (i in 0 until sources.size()) {
            val uri = sources.getString(i) ?: continue
            if (thumbFailedUris.contains(uri)) continue
            uris.add(uri)
        }
        thumbExecutor.execute {
            for (uri in uris) {
                if (destroyed) break
                if (!thumbInProgress.add(uri)) continue
                try {
                    val cacheFile = thumbCacheFile(uri, size) ?: continue
                    if (cacheFile.isFile && cacheFile.length() > 0) continue
                    decodeToThumbnail(uri, cacheFile, size)
                } catch (error: Throwable) {
                    thumbFailedUris.add(uri)
                    Log.w(TAG, "prepareThumbnails failed: $uri", error)
                } finally {
                    thumbInProgress.remove(uri)
                }
            }
            maybeCleanupThumbCache()
        }
    }

    // ---------- 缩略图内部实现 ----------

    private fun thumbCacheDir(): File {
        val dir = File(reactContext.cacheDir, THUMB_DIR)
        if (!dir.isDirectory) dir.mkdirs()
        return dir
    }

    private fun thumbCacheFile(sourceUri: String, targetSize: Int): File? {
        return try {
            val digest = MessageDigest.getInstance("SHA-1")
                .digest("$sourceUri@$targetSize".toByteArray(Charsets.UTF_8))
            val hex = digest.joinToString("") { "%02x".format(it) }
            File(thumbCacheDir(), "$hex.jpg")
        } catch (error: Throwable) {
            Log.w(TAG, "thumbCacheFile failed", error)
            null
        }
    }

    private fun openSource(sourceUri: String): InputStream? {
        val resolver: ContentResolver = reactContext.contentResolver
        return try {
            if (sourceUri.startsWith("content://")) {
                resolver.openInputStream(Uri.parse(sourceUri))
            } else {
                val file = File(toRealPath(sourceUri))
                if (!file.isFile) null else file.inputStream()
            }
        } catch (error: Throwable) {
            Log.w(TAG, "openSource failed: $sourceUri", error)
            null
        }
    }

    private fun decodeToThumbnail(sourceUri: String, cacheFile: File, targetSize: Int) {
        // 1) 只读尺寸
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        openSource(sourceUri)?.use { input ->
            BitmapFactory.decodeStream(input, null, bounds)
        } ?: throw IllegalStateException("cannot open source")
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw IllegalStateException("undecodable: $sourceUri")
        }

        // 2) inSampleSize：短边落在 [targetSize, 2*targetSize)
        var width = bounds.outWidth
        var height = bounds.outHeight
        var sample = 1
        while (minOf(width, height) / 2 >= targetSize) {
            sample *= 2
            width /= 2
            height /= 2
        }

        // 3) 真实解码
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        val bitmap = openSource(sourceUri)?.use { input ->
            BitmapFactory.decodeStream(input, null, options)
        } ?: throw IllegalStateException("cannot reopen source")

        // 4) 写缓存（临时文件 + rename，避免读到半张图）
        val tmp = File(cacheFile.absolutePath + ".tmp")
        FileOutputStream(tmp).use { output ->
            bitmap.compress(Bitmap.CompressFormat.JPEG, 80, output)
            output.flush()
        }
        if (!tmp.renameTo(cacheFile)) {
            tmp.copyTo(cacheFile, overwrite = true)
            tmp.delete()
        }
        bitmap.recycle()
    }

    private fun emitThumbnailReady(sourceUri: String) {
        if (destroyed || !reactContext.hasActiveCatalystInstance()) return
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("onThumbnailReady", sourceUri)
        } catch (error: Throwable) {
            // JS 侧未挂监听时静默（预热场景常见）
        }
    }

    private fun maybeCleanupThumbCache() {
        if (thumbCleanupCounter.incrementAndGet() % THUMB_CLEANUP_EVERY != 0L) return
        try {
            val dir = thumbCacheDir()
            val files = dir.listFiles() ?: return
            var total = files.sumOf { it.length() }
            if (total <= THUMB_CACHE_LIMIT_BYTES) return
            files.sortedBy { it.lastModified() }.forEach { file ->
                if (total <= THUMB_CACHE_TARGET_BYTES) return
                val length = file.length()
                if (file.delete()) total -= length
            }
        } catch (error: Throwable) {
            Log.w(TAG, "thumb cache cleanup failed", error)
        }
    }

    private fun toRealPath(uriOrPath: String): String {
        val raw =
            if (uriOrPath.startsWith("file://")) {
                uriOrPath.removePrefix("file://")
            } else {
                uriOrPath
            }
        return Uri.decode(raw)
    }
}

class StorageAccessPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(StorageAccessModule(reactContext))

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<in Nothing, in Nothing>> =
        emptyList()
}
