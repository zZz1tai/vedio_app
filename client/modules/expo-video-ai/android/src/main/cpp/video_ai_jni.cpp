#include <android/bitmap.h>
#include <android/log.h>
#include <jni.h>

#include <algorithm>
#include <atomic>
#include <cstring>
#include <fstream>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "gpu.h"
#include "net.h"
#include "cpu.h"
#include "rife.h"

namespace {

constexpr char kTag[] = "ExpoVideoAi";
constexpr int kScale = 2;
constexpr int kTileSize = 192;
constexpr int kTilePadding = 16;

std::mutex g_mutex;
std::unique_ptr<ncnn::Net> g_super_resolution;
std::unique_ptr<RIFE> g_rife;
bool g_gpu_instance_created = false;
std::atomic<bool> g_cancelled(false);
std::string g_last_error;

void log_error(const char* message) {
  g_last_error = message;
  __android_log_print(ANDROID_LOG_ERROR, kTag, "%s", message);
}

bool has_model_file(const std::string& path) {
  std::ifstream stream(path, std::ios::binary | std::ios::ate);
  return stream.good() && stream.tellg() > 0;
}

bool ensure_gpu() {
  if (!g_gpu_instance_created) {
    ncnn::create_gpu_instance();
    g_gpu_instance_created = true;
  }
  return ncnn::get_gpu_count() > 0;
}

void reset_engine() {
  g_rife.reset();
  g_super_resolution.reset();
  if (g_gpu_instance_created) {
    ncnn::destroy_gpu_instance();
    g_gpu_instance_created = false;
  }
}

bool bitmap_to_rgb(JNIEnv* env, jobject bitmap, std::vector<unsigned char>* rgb, int* width, int* height) {
  AndroidBitmapInfo info{};
  if (AndroidBitmap_getInfo(env, bitmap, &info) != ANDROID_BITMAP_RESULT_SUCCESS ||
      info.format != ANDROID_BITMAP_FORMAT_RGBA_8888) {
    log_error("Expected an ARGB_8888 bitmap");
    return false;
  }

  void* pixels = nullptr;
  if (AndroidBitmap_lockPixels(env, bitmap, &pixels) != ANDROID_BITMAP_RESULT_SUCCESS || !pixels) {
    log_error("Unable to lock bitmap pixels");
    return false;
  }

  *width = static_cast<int>(info.width);
  *height = static_cast<int>(info.height);
  rgb->resize(static_cast<size_t>(*width) * static_cast<size_t>(*height) * 3);

  const auto* source = static_cast<const unsigned char*>(pixels);
  for (int y = 0; y < *height; ++y) {
    const auto* source_row = source + static_cast<size_t>(y) * info.stride;
    auto* destination = rgb->data() + static_cast<size_t>(y) * static_cast<size_t>(*width) * 3;
    for (int x = 0; x < *width; ++x) {
      destination[x * 3] = source_row[x * 4];
      destination[x * 3 + 1] = source_row[x * 4 + 1];
      destination[x * 3 + 2] = source_row[x * 4 + 2];
    }
  }

  AndroidBitmap_unlockPixels(env, bitmap);
  return true;
}

jobject rgb_to_bitmap(JNIEnv* env, const unsigned char* rgb, int width, int height) {
  jclass bitmap_class = env->FindClass("android/graphics/Bitmap");
  jclass config_class = env->FindClass("android/graphics/Bitmap$Config");
  if (!bitmap_class || !config_class) return nullptr;

  const jfieldID argb_8888 = env->GetStaticFieldID(
      config_class, "ARGB_8888", "Landroid/graphics/Bitmap$Config;");
  const jmethodID create_bitmap = env->GetStaticMethodID(
      bitmap_class, "createBitmap", "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;");
  if (!argb_8888 || !create_bitmap) return nullptr;

  const jobject config = env->GetStaticObjectField(config_class, argb_8888);
  const jobject bitmap = env->CallStaticObjectMethod(bitmap_class, create_bitmap, width, height, config);
  if (env->ExceptionCheck() || !bitmap) {
    env->ExceptionClear();
    return nullptr;
  }

  AndroidBitmapInfo info{};
  void* pixels = nullptr;
  if (AndroidBitmap_getInfo(env, bitmap, &info) != ANDROID_BITMAP_RESULT_SUCCESS ||
      AndroidBitmap_lockPixels(env, bitmap, &pixels) != ANDROID_BITMAP_RESULT_SUCCESS || !pixels) {
    return nullptr;
  }

  auto* destination = static_cast<unsigned char*>(pixels);
  for (int y = 0; y < height; ++y) {
    auto* destination_row = destination + static_cast<size_t>(y) * info.stride;
    const auto* source = rgb + static_cast<size_t>(y) * static_cast<size_t>(width) * 3;
    for (int x = 0; x < width; ++x) {
      destination_row[x * 4] = source[x * 3];
      destination_row[x * 4 + 1] = source[x * 3 + 1];
      destination_row[x * 4 + 2] = source[x * 3 + 2];
      destination_row[x * 4 + 3] = 255;
    }
  }

  AndroidBitmap_unlockPixels(env, bitmap);
  return bitmap;
}

ncnn::Mat make_tile(const ncnn::Mat& source, int x, int y, int width, int height) {
  ncnn::Mat tile(width, height, 3);
  for (int channel = 0; channel < 3; ++channel) {
    const ncnn::Mat source_channel = source.channel(channel);
    ncnn::Mat tile_channel = tile.channel(channel);
    for (int row = 0; row < height; ++row) {
      std::memcpy(tile_channel.row(row), source_channel.row(y + row) + x,
                  static_cast<size_t>(width) * sizeof(float));
    }
  }
  return tile;
}

bool run_super_resolution(const ncnn::Mat& input, ncnn::Mat* output) {
  if (!g_super_resolution) return false;

  output->create(input.w * kScale, input.h * kScale, 3);
  if (output->empty()) return false;

  for (int y = 0; y < input.h; y += kTileSize) {
    const int tile_height = std::min(kTileSize, input.h - y);
    const int input_y = std::max(0, y - kTilePadding);
    const int input_y_end = std::min(input.h, y + tile_height + kTilePadding);
    for (int x = 0; x < input.w; x += kTileSize) {
      if (g_cancelled.load()) return false;
      const int tile_width = std::min(kTileSize, input.w - x);
      const int input_x = std::max(0, x - kTilePadding);
      const int input_x_end = std::min(input.w, x + tile_width + kTilePadding);
      const ncnn::Mat tile = make_tile(input, input_x, input_y, input_x_end - input_x, input_y_end - input_y);

      ncnn::Extractor extractor = g_super_resolution->create_extractor();
      extractor.set_light_mode(true);
      if (extractor.input("data", tile) != 0) return false;
      ncnn::Mat enhanced_tile;
      if (extractor.extract("output", enhanced_tile) != 0 || enhanced_tile.empty()) return false;

      const int source_x_offset = (x - input_x) * kScale;
      const int source_y_offset = (y - input_y) * kScale;
      for (int channel = 0; channel < 3; ++channel) {
        const ncnn::Mat enhanced_channel = enhanced_tile.channel(channel);
        ncnn::Mat output_channel = output->channel(channel);
        for (int row = 0; row < tile_height * kScale; ++row) {
          std::memcpy(output_channel.row(y * kScale + row) + x * kScale,
                      enhanced_channel.row(source_y_offset + row) + source_x_offset,
                      static_cast<size_t>(tile_width * kScale) * sizeof(float));
        }
      }
    }
  }
  return true;
}

bool load_engine(const std::string& model_dir) {
  g_last_error.clear();
  reset_engine();
  if (!ensure_gpu()) {
    log_error("未检测到可用 Vulkan GPU");
    return false;
  }

  ncnn::VulkanDevice* vkdev = ncnn::get_gpu_device(0);
  if (!vkdev) {
    log_error("无法创建 NCNN Vulkan 设备");
    reset_engine();
    return false;
  }

  const std::string sr_param = model_dir + "/realesr-animevideov3-x2.param";
  const std::string sr_model = model_dir + "/realesr-animevideov3-x2.bin";
  const std::string rife_param = model_dir + "/rife-v4.6/flownet.param";
  const std::string rife_model = model_dir + "/rife-v4.6/flownet.bin";
  if (!has_model_file(sr_param) || !has_model_file(sr_model) ||
      !has_model_file(rife_param) || !has_model_file(rife_model)) {
    log_error("AI 模型文件不完整，请清除应用数据后重新安装");
    reset_engine();
    return false;
  }

  g_super_resolution = std::make_unique<ncnn::Net>();
  g_super_resolution->set_vulkan_device(vkdev);
  g_super_resolution->opt.use_vulkan_compute = true;
  g_super_resolution->opt.use_fp16_packed = true;
  g_super_resolution->opt.use_fp16_storage = true;
  g_super_resolution->opt.use_fp16_arithmetic = true;
  const int param_result = g_super_resolution->load_param(sr_param.c_str());
  const int model_result = param_result == 0 ? g_super_resolution->load_model(sr_model.c_str()) : param_result;
  if (param_result != 0 || model_result != 0) {
    const std::string message = "Real-ESRGAN 模型加载失败（param=" +
        std::to_string(param_result) + "，model=" + std::to_string(model_result) + "）";
    log_error(message.c_str());
    reset_engine();
    return false;
  }

  // RIFE v4.6's upstream custom Vulkan shaders target an older NCNN shader ABI.
  // Keep Real-ESRGAN on Vulkan and use all big CPU cores for stable interpolation.
  const int rife_threads = std::max(1, ncnn::get_big_cpu_count());
  g_rife = std::make_unique<RIFE>(-1, false, false, false, rife_threads, false, true);
  if (g_rife->load(model_dir + "/rife-v4.6") != 0) {
    log_error("RIFE 模型加载失败");
    reset_engine();
    return false;
  }

  g_cancelled.store(false);
  return true;
}

}  // namespace

extern "C" JNIEXPORT jboolean JNICALL
Java_expo_modules_videoai_AiNativeEngine_nativeIsSupported(JNIEnv*, jobject) {
  std::lock_guard<std::mutex> lock(g_mutex);
  const bool supported = ensure_gpu();
  if (g_gpu_instance_created && !g_super_resolution && !g_rife) {
    ncnn::destroy_gpu_instance();
    g_gpu_instance_created = false;
  }
  return supported ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_expo_modules_videoai_AiNativeEngine_nativeInitialize(JNIEnv* env, jobject, jstring model_dir) {
  if (!model_dir) {
    std::lock_guard<std::mutex> lock(g_mutex);
    log_error("模型目录为空");
    return JNI_FALSE;
  }
  const char* raw_path = env->GetStringUTFChars(model_dir, nullptr);
  if (!raw_path) {
    std::lock_guard<std::mutex> lock(g_mutex);
    log_error("无法读取模型目录");
    return JNI_FALSE;
  }
  const std::string path(raw_path);
  env->ReleaseStringUTFChars(model_dir, raw_path);
  std::lock_guard<std::mutex> lock(g_mutex);
  return load_engine(path) ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jstring JNICALL
Java_expo_modules_videoai_AiNativeEngine_nativeLastError(JNIEnv* env, jobject) {
  std::lock_guard<std::mutex> lock(g_mutex);
  return env->NewStringUTF(g_last_error.c_str());
}

extern "C" JNIEXPORT jobject JNICALL
Java_expo_modules_videoai_AiNativeEngine_nativeUpscale(JNIEnv* env, jobject, jobject bitmap) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (!g_super_resolution || !bitmap || g_cancelled.load()) return nullptr;

  std::vector<unsigned char> rgb;
  int width = 0;
  int height = 0;
  if (!bitmap_to_rgb(env, bitmap, &rgb, &width, &height)) return nullptr;
  ncnn::Mat input = ncnn::Mat::from_pixels(rgb.data(), ncnn::Mat::PIXEL_RGB, width, height);
  const float norm_vals[3] = {1.f / 255.f, 1.f / 255.f, 1.f / 255.f};
  input.substract_mean_normalize(nullptr, norm_vals);
  ncnn::Mat output;
  if (!run_super_resolution(input, &output) || output.empty() || g_cancelled.load()) return nullptr;

  const float denorm_vals[3] = {255.f, 255.f, 255.f};
  output.substract_mean_normalize(nullptr, denorm_vals);
  std::vector<unsigned char> enhanced(static_cast<size_t>(output.w) * static_cast<size_t>(output.h) * 3);
  output.to_pixels(enhanced.data(), ncnn::Mat::PIXEL_RGB);
  return rgb_to_bitmap(env, enhanced.data(), output.w, output.h);
}

extern "C" JNIEXPORT jobject JNICALL
Java_expo_modules_videoai_AiNativeEngine_nativeInterpolate(JNIEnv* env, jobject, jobject first, jobject second) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (!g_rife || !first || !second || g_cancelled.load()) return nullptr;

  std::vector<unsigned char> first_rgb;
  std::vector<unsigned char> second_rgb;
  int width = 0;
  int height = 0;
  int second_width = 0;
  int second_height = 0;
  if (!bitmap_to_rgb(env, first, &first_rgb, &width, &height) ||
      !bitmap_to_rgb(env, second, &second_rgb, &second_width, &second_height) ||
      width != second_width || height != second_height) {
    return nullptr;
  }

  ncnn::Mat first_image(width, height, first_rgb.data(), static_cast<size_t>(3), 1);
  ncnn::Mat second_image(width, height, second_rgb.data(), static_cast<size_t>(3), 1);

  // RIFE's CPU path serializes the final RGB image directly into outimage.data.
  // It does not allocate outimage itself, so an empty Mat makes ncnn::Mat::to_pixels()
  // write through a null pointer. This was exposed by the super-resolution +
  // interpolation pipeline as a native SIGSEGV.
  ncnn::Mat output(width, height, 3, static_cast<size_t>(1));
  if (output.empty()) {
    log_error("无法分配 RIFE 输出缓冲区");
    return nullptr;
  }
  if (g_rife->process(first_image, second_image, 0.5f, output) != 0 ||
      output.empty() || output.w != width || output.h != height || g_cancelled.load()) {
    log_error("RIFE 插帧推理失败");
    return nullptr;
  }
  return rgb_to_bitmap(env, static_cast<const unsigned char*>(output.data), output.w, output.h);
}

extern "C" JNIEXPORT void JNICALL
Java_expo_modules_videoai_AiNativeEngine_nativeCancel(JNIEnv*, jobject) {
  g_cancelled.store(true);
}

extern "C" JNIEXPORT void JNICALL
Java_expo_modules_videoai_AiNativeEngine_nativeClose(JNIEnv*, jobject) {
  std::lock_guard<std::mutex> lock(g_mutex);
  g_cancelled.store(true);
  reset_engine();
}
