package com.anonymous.x0

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.MediaScannerConnection
import android.net.Uri
import android.util.Base64
import android.util.Log
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager
import java.io.File
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.util.concurrent.Executors

class BiliMuxerModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val executor = Executors.newSingleThreadExecutor()
    private var lastEmitAt = 0L

    override fun getName() = "BiliMuxer"

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun readFileHead(path: String, length: Int): String {
        return try {
            val file = File(toRealPath(path))
            if (!file.isFile) return ""
            val size = minOf(length.coerceAtLeast(0), file.length().toInt())
            if (size == 0) return ""
            val buffer = ByteArray(size)
            FileInputStream(file).use { input ->
                var read = 0
                while (read < size) {
                    val n = input.read(buffer, read, size - read)
                    if (n < 0) break
                    read += n
                }
            }
            Base64.encodeToString(buffer, 0, size, Base64.NO_WRAP)
        } catch (error: Throwable) {
            Log.w("BiliMuxer", "readFileHead failed", error)
            ""
        }
    }

    @ReactMethod
    fun mergeMp4(videoPath: String, audioPath: String, outputPath: String, tag: String, promise: Promise) {
        executor.execute {
            try {
                val output = File(toRealPath(outputPath))
                output.parentFile?.let { parent ->
                    if (!parent.exists()) parent.mkdirs()
                }
                if (output.exists()) output.delete()

                val muxer = MediaMuxer(output.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
                try {
                    val videoSource = openTrack(videoPath, preferAudio = false)
                        ?: throw IllegalArgumentException("无法从视频文件解析出可用轨道")
                    val audioSource = if (audioPath.isNotBlank() && toRealPath(audioPath) != toRealPath(videoPath)) {
                        openTrack(audioPath, preferAudio = true)
                    } else {
                        null
                    }

                    val totalBytes = listOfNotNull(
                        File(toRealPath(videoPath)).length(),
                        audioSource?.let { File(toRealPath(audioPath)).length() }
                    ).sum()

                    var videoMuxTrack = -1
                    var audioMuxTrack = -1
                    try {
                        videoMuxTrack = muxer.addTrack(videoSource.format)
                        if (audioSource != null) {
                            audioMuxTrack = muxer.addTrack(audioSource.format)
                        }
                        muxer.start()

                        var written = copyInto(muxer, videoMuxTrack, videoSource) { bytes ->
                            emitProgress(tag, bytes, totalBytes)
                        }
                        if (audioSource != null) {
                            written += copyInto(muxer, audioMuxTrack, audioSource) { bytes ->
                                emitProgress(tag, written + bytes, totalBytes)
                            }
                            emitProgress(tag, written, totalBytes)
                        } else {
                            emitProgress(tag, totalBytes, totalBytes)
                        }
                    } finally {
                        videoSource.extractor.release()
                        audioSource?.let { it.extractor.release() }
                        try {
                            muxer.stop()
                        } catch (error: Throwable) {
                            Log.w("BiliMuxer", "muxer.stop failed", error)
                        }
                    }

                    MediaScannerConnection.scanFile(
                        reactContext,
                        arrayOf(output.absolutePath),
                        arrayOf("video/mp4"),
                        null
                    )
                    promise.resolve(true)
                } catch (error: Throwable) {
                    output.delete()
                    throw error
                }
            } catch (error: Throwable) {
                Log.w("BiliMuxer", "mergeMp4 failed", error)
                promise.reject("MERGE_FAILED", error.message ?: "合成失败", error)
            }
        }
    }

    private class Source(
        val extractor: MediaExtractor,
        val format: MediaFormat,
        val maxSampleSize: Int
    )

    private fun openTrack(path: String, preferAudio: Boolean): Source? {
        val extractor = MediaExtractor()
        return try {
            extractor.setDataSource(toRealPath(path))
            var chosen = -1
            var fallback: Pair<Int, MediaFormat>? = null
            var chosenFormat: MediaFormat? = null
            for (i in 0 until extractor.trackCount) {
                val format = extractor.getTrackFormat(i)
                val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
                val isVideo = mime.startsWith("video/")
                val isAudio = mime.startsWith("audio/")
                if (!isVideo && !isAudio) continue
                val matchesPreference = if (preferAudio) isAudio else isVideo
                if (matchesPreference) {
                    chosen = i
                    chosenFormat = format
                    break
                }
                if (fallback == null) fallback = i to format
            }
            if (chosen == -1) {
                val fb = fallback
                if (fb == null) {
                    extractor.release()
                    return null
                }
                chosen = fb.first
                chosenFormat = fb.second
            }
            val selectedFormat = chosenFormat ?: run {
                extractor.release()
                return null
            }
            extractor.selectTrack(chosen)
            val maxInput = selectedFormat.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE).takeIf { it > 0 }
                ?: (2 * 1024 * 1024)
            val bufferSize = maxInput.coerceIn(256 * 1024, 32 * 1024 * 1024)
            Source(extractor, selectedFormat, bufferSize)
        } catch (error: Throwable) {
            Log.w("BiliMuxer", "openTrack failed for $path", error)
            runCatching { extractor.release() }
            null
        }
    }

    private fun copyInto(muxer: MediaMuxer, muxTrack: Int, source: Source, onChunk: (Long) -> Unit): Long {
        val buffer = ByteBuffer.allocateDirect(source.maxSampleSize)
        val info = MediaCodec.BufferInfo()
        var chunkBytes = 0L
        while (true) {
            info.offset = 0
            info.size = source.extractor.readSampleData(buffer, 0)
            if (info.size < 0) break
            info.presentationTimeUs = source.extractor.sampleTime
            info.flags = if (source.extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) {
                MediaCodec.BUFFER_FLAG_KEY_FRAME
            } else {
                0
            }
            muxer.writeSampleData(muxTrack, buffer, info)
            chunkBytes += info.size
            onChunk(chunkBytes)
            if (!source.extractor.advance()) break
        }
        return chunkBytes
    }

    private fun emitProgress(tag: String, bytes: Long, total: Long) {
        val now = System.currentTimeMillis()
        if (bytes < total && now - lastEmitAt < 120) return
        lastEmitAt = now
        val params = Arguments.createMap().apply {
            putString("tag", tag)
            putDouble("bytes", bytes.toDouble())
            putDouble("total", total.toDouble().coerceAtLeast(1.0))
        }
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("BiliMergeProgress", params)
        } catch (_: Throwable) {
        }
    }

    private fun toRealPath(uriOrPath: String): String {
        val raw = if (uriOrPath.startsWith("file://")) {
            uriOrPath.removePrefix("file://")
        } else {
            uriOrPath
        }
        return Uri.decode(raw)
    }
}

class BiliMuxerPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(BiliMuxerModule(reactContext))

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<in Nothing, in Nothing>> =
        emptyList()
}
