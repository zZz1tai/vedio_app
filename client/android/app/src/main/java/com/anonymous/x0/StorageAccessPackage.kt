package com.anonymous.x0

import android.net.Uri
import android.os.Build
import android.os.Environment
import android.util.Log
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager
import java.io.File
import java.nio.file.Files

class StorageAccessModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "StorageAccess"

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
            Log.w("StorageAccess", "renameFile failed", error)
            false
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
