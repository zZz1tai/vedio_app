#include <android/bitmap.h>
#include <android/log.h>
#include <jni.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <fstream>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "cpu.h"
#include "gpu.h"
#include "net.h"
#include "rife.h"

namespace {

constexpr char kTag[] = "ExpoVideoAi";
constexpr int kVideoScale = 2;
constexpr int kTilePadding = 16;
constexpr int kMinTileSize = 64;
constexpr int kMaxTileSize = 512;

std::mutex g_mutex;
std::unique_ptr<ncnn::Net> g_super_resolution;
// 图片超分专用引擎：加载 realesr-general-x4v3（4x 通用降噪模型），与视频 2x 模型独立共存。
std::unique_ptr<ncnn::Net> g_image_super_resolution;
int g_image_scale = 4;
std::unique_ptr<RIFE> g_rife;
// RIFE 后端：true = Vulkan GPU，false = CPU。初始化时探测，Vulkan 不可用则回退。
bool g_rife_vulkan = false;
// Real-ESRGAN 分块尺寸。显存/内存吃紧时调小，追求吞吐时调大。
int g_tile_size = 192;
bool g_gpu_instance_created = false;
std::atomic<bool> g_cancelled(false);
std::string g_last_error;

void log_error(const char* message) {
  g_last_error = message;
  __android_log_print(ANDROID_LOG_ERROR, kTag, "%s", message);
}

inline unsigned char clamp_byte(int value) {
  return static_cast<unsigned char>(value < 0 ? 0 : (value > 255 ? 255 : value));
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
  g_image_super_resolution.reset();
  if (g_gpu_instance_created) {
    ncnn::destroy_gpu_instance();
    g_gpu_instance_created = false;
  }
  g_rife_vulkan = false;
}

struct PlaneView {
  const unsigned char* data = nullptr;
  size_t size = 0;
};

bool lock_plane(JNIEnv* env, jobject buffer, PlaneView* view) {
  if (!buffer) return false;
  void* address = env->GetDirectBufferAddress(buffer);
  if (!address) return false;
  jclass cls = env->GetObjectClass(buffer);
  if (!cls) return false;
  const jmethodID position_id = env->GetMethodID(cls, "position", "()I");
  const jmethodID remaining_id = env->GetMethodID(cls, "remaining", "()I");
  if (!position_id || !remaining_id) {
    env->DeleteLocalRef(cls);
    return false;
  }
  const jint position = env->CallIntMethod(buffer, position_id);
  const jint remaining = env->CallIntMethod(buffer, remaining_id);
  env->DeleteLocalRef(cls);
  if (remaining <= 0) return false;
  view->data = static_cast<const unsigned char*>(address) + position;
  view->size = static_cast<size_t>(remaining);
  return true;
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

/**
 * 把一块 float 分块结果反归一化后直接写进最终 RGB 缓冲。
 *
 * 原实现先分配一张 (w*2) x (h*2) 的 float Mat 做中转，4K 输出时这块缓冲接近 100MB，
 * 再额外拷贝到一份 uint8 缓冲，无论内存占用还是带宽都是浪费。
 * 这里按分块就地转换，中转缓冲恒定为一小块。
 */
void write_tile_rgb(const ncnn::Mat& tile, unsigned char* destination, int destination_width,
                    int destination_x, int destination_y,
                    int source_x, int source_y, int width, int height) {
  const ncnn::Mat red = tile.channel(0);
  const ncnn::Mat green = tile.channel(1);
  const ncnn::Mat blue = tile.channel(2);
  for (int row = 0; row < height; ++row) {
    const float* red_row = red.row(source_y + row) + source_x;
    const float* green_row = green.row(source_y + row) + source_x;
    const float* blue_row = blue.row(source_y + row) + source_x;
    unsigned char* out_row =
        destination + (static_cast<size_t>(destination_y + row) * static_cast<size_t>(destination_width) +
                       static_cast<size_t>(destination_x)) * 3;
    for (int column = 0; column < width; ++column) {
      out_row[column * 3] = clamp_byte(static_cast<int>(red_row[column] * 255.f + 0.5f));
      out_row[column * 3 + 1] = clamp_byte(static_cast<int>(green_row[column] * 255.f + 0.5f));
      out_row[column * 3 + 2] = clamp_byte(static_cast<int>(blue_row[column] * 255.f + 0.5f));
    }
  }
}

bool run_super_resolution(const ncnn::Mat& input, int scale, std::vector<unsigned char>* rgb,
                          int* output_width, int* output_height) {
  if (!g_super_resolution) return false;

  const int out_width = input.w * scale;
  const int out_height = input.h * scale;
  rgb->resize(static_cast<size_t>(out_width) * static_cast<size_t>(out_height) * 3);
  *output_width = out_width;
  *output_height = out_height;

  const int tile_size = std::clamp(g_tile_size, kMinTileSize, kMaxTileSize);

  for (int y = 0; y < input.h; y += tile_size) {
    const int tile_height = std::min(tile_size, input.h - y);
    const int input_y = std::max(0, y - kTilePadding);
    const int input_y_end = std::min(input.h, y + tile_height + kTilePadding);
    for (int x = 0; x < input.w; x += tile_size) {
      if (g_cancelled.load()) return false;
      const int tile_width = std::min(tile_size, input.w - x);
      const int input_x = std::max(0, x - kTilePadding);
      const int input_x_end = std::min(input.w, x + tile_width + kTilePadding);
      const ncnn::Mat tile = make_tile(input, input_x, input_y, input_x_end - input_x, input_y_end - input_y);

      // 每个分块都重建 Extractor。
      // 复用 Extractor + light_mode 时 ncnn 会复用 blob 内存，
      // 但 Real-ESRGAN 这种全卷积网络在多次连续 extract 时，
      // light_mode 的内存复用策略会导致后续块的 output 实际指向
      // 与前一块相同（或被覆盖）的内存，从而所有 tile 输出近似
      // 同一张图，画面被强行打成 12 块网格（人物被"平均"掉）。
      // 每块重建 Extractor 是有代价的（每帧多分配若干次），
      // 但正确性优先，速度后续可走并行 / pipeline 优化。
      ncnn::Extractor extractor = g_super_resolution->create_extractor();
      extractor.set_light_mode(true);

      ncnn::Mat enhanced_tile;
      if (extractor.input("data", tile) != 0) return false;
      if (extractor.extract("output", enhanced_tile) != 0 || enhanced_tile.empty()) return false;

      write_tile_rgb(
          enhanced_tile, rgb->data(), out_width,
          x * scale, y * scale,
          (x - input_x) * scale, (y - input_y) * scale,
          tile_width * scale, tile_height * scale);
    }
  }
  return true;
}

/**
 * 图片超分：对整张 Bitmap 走 4x 模型（realesr-general-x4v3）推理。
 * 与视频共用 [run_super_resolution] 的分块逻辑，但使用独立的
 * [g_image_super_resolution] 网络，互不影响（视频引擎只加载 2x 模型，
 * 图片模型是 4x，两者不能复用同一个 ncnn::Net）。
 */
bool run_image_super_resolution(const ncnn::Mat& input, std::vector<unsigned char>* rgb,
                                int* output_width, int* output_height) {
  if (!g_image_super_resolution) return false;
  const int scale = g_image_scale;
  const int out_width = input.w * scale;
  const int out_height = input.h * scale;
  rgb->resize(static_cast<size_t>(out_width) * static_cast<size_t>(out_height) * 3);
  *output_width = out_width;
  *output_height = out_height;

  const int tile_size = std::clamp(g_tile_size, kMinTileSize, kMaxTileSize);

  for (int y = 0; y < input.h; y += tile_size) {
    const int tile_height = std::min(tile_size, input.h - y);
    const int input_y = std::max(0, y - kTilePadding);
    const int input_y_end = std::min(input.h, y + tile_height + kTilePadding);
    for (int x = 0; x < input.w; x += tile_size) {
      if (g_cancelled.load()) return false;
      const int tile_width = std::min(tile_size, input.w - x);
      const int input_x = std::max(0, x - kTilePadding);
      const int input_x_end = std::min(input.w, x + tile_width + kTilePadding);
      const ncnn::Mat tile = make_tile(input, input_x, input_y, input_x_end - input_x, input_y_end - input_y);

      ncnn::Extractor extractor = g_image_super_resolution->create_extractor();
      extractor.set_light_mode(true);

      ncnn::Mat enhanced_tile;
      if (extractor.input("data", tile) != 0) return false;
      if (extractor.extract("output", enhanced_tile) != 0 || enhanced_tile.empty()) return false;

      write_tile_rgb(
          enhanced_tile, rgb->data(), out_width,
          x * scale, y * scale,
          (x - input_x) * scale, (y - input_y) * scale,
          tile_width * scale, tile_height * scale);
    }
  }
  return true;
}

/** 两帧之间的平均绝对差（每 4 个像素采样一次），用于判断运动量。 */
double mean_abs_diff(const ncnn::Mat& a, const ncnn::Mat& b) {
  if (a.w != b.w || a.h != b.h) return -1.0;
  const auto* pa = static_cast<const unsigned char*>(a.data);
  const auto* pb = static_cast<const unsigned char*>(b.data);
  const size_t total = static_cast<size_t>(a.w) * static_cast<size_t>(a.h) * 3u;
  double sum = 0.0;
  size_t samples = 0;
  for (size_t i = 0; i + 2 < total; i += 12) {
    sum += std::fabs(static_cast<double>(pa[i]) - static_cast<double>(pb[i]));
    sum += std::fabs(static_cast<double>(pa[i + 1]) - static_cast<double>(pb[i + 1]));
    sum += std::fabs(static_cast<double>(pa[i + 2]) - static_cast<double>(pb[i + 2]));
    samples += 3;
  }
  return samples == 0 ? 0.0 : sum / static_cast<double>(samples);
}

/**
 * 插帧结果合理性校验。
 *
 * 中间帧应当「落在」两帧之间：它到两帧的距离之和，不应明显超过两帧之间的距离。
 * 一旦超出，说明光流没有收敛（典型场景是两帧之间实际间隔远大于一个帧间隔），
 * 此时输出多半是鬼影或撕裂，直接判定失败让上层降级为复制。
 */
bool interpolation_is_sane(const ncnn::Mat& first, const ncnn::Mat& second, const ncnn::Mat& middle) {
  const double between = mean_abs_diff(first, second);
  const double to_first = mean_abs_diff(first, middle);
  const double to_second = mean_abs_diff(second, middle);
  if (between < 0.0 || to_first < 0.0 || to_second < 0.0) return false;
  if (between < 2.0) return true;  // 两帧几乎一致，任何输出都合理
  const double worst = std::max(to_first, to_second);
  return worst <= between * 2.5 + 8.0;
}

/**
 * 尝试用 Vulkan 后端加载 RIFE。
 *
 * RIFE v4.6 上游自带的自定义 Vulkan shader 面向较老的 ncnn shader ABI，
 * 在部分设备/驱动上会编译失败或产出垃圾。这里不盲信 load() 的返回值，
 * 而是实跑一帧小图验证输出非空，通不过就交由调用方回退到 CPU。
 */
bool try_load_rife_vulkan(const std::string& model_dir, int threads) {
  auto rife = std::make_unique<RIFE>(0, false, false, false, threads, false, true);
  if (rife->load(model_dir + "/rife-v4.6") != 0) return false;

  constexpr int kProbe = 64;
  std::vector<unsigned char> first_rgb(static_cast<size_t>(kProbe) * kProbe * 3);
  std::vector<unsigned char> second_rgb(static_cast<size_t>(kProbe) * kProbe * 3);
  for (size_t i = 0; i < first_rgb.size(); ++i) {
    first_rgb[i] = static_cast<unsigned char>((i * 5) % 251);
    second_rgb[i] = static_cast<unsigned char>((i * 11 + 37) % 251);
  }
  const ncnn::Mat first(kProbe, kProbe, first_rgb.data(), static_cast<size_t>(3), 1);
  const ncnn::Mat second(kProbe, kProbe, second_rgb.data(), static_cast<size_t>(3), 1);
  ncnn::Mat output(kProbe, kProbe, 3, static_cast<size_t>(1));
  if (output.empty() || rife->process(first, second, 0.5f, output) != 0) return false;
  if (output.w != kProbe || output.h != kProbe) return false;

  const auto* pixels = static_cast<const unsigned char*>(output.data);
  bool non_trivial = false;
  for (size_t i = 0; i < first_rgb.size(); ++i) {
    if (pixels[i] > 2) {
      non_trivial = true;
      break;
    }
  }
  if (!non_trivial) return false;

  g_rife = std::move(rife);
  g_rife_vulkan = true;
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

  const int rife_threads = std::max(1, ncnn::get_big_cpu_count());
  // RIFE 暂时只用 CPU。Vulkan 路径在 HyperOS/Android 16（Adreno 驱动）上
  // 会在 load_model 创建上游自定义 Warp shader 管线时间歇性 SIGSEGV
  // （ncnn::resolve_shader_info 空指针），进程级崩溃无法被自检拦截，
  // 「失败回退 CPU」形同虚设。v1.6.0 的已验证配置即 RIFE CPU + SR Vulkan。
  // 待 ncnn/上游 shader ABI 适配后再尝试启用 kEnableRifeVulkan。
  constexpr bool kEnableRifeVulkan = false;
  if (kEnableRifeVulkan && !try_load_rife_vulkan(model_dir, rife_threads)) {
    if (g_rife) {
      __android_log_print(ANDROID_LOG_WARN, kTag, "RIFE Vulkan 自检失败，回退 CPU");
    }
    g_rife.reset();
    g_rife_vulkan = false;
  }
  if (!g_rife) {
    g_rife_vulkan = false;
    g_rife = std::make_unique<RIFE>(-1, false, false, false, rife_threads, false, true);
    if (g_rife->load(model_dir + "/rife-v4.6") != 0) {
      log_error("RIFE 模型加载失败");
      reset_engine();
      return false;
    }
  }
  __android_log_print(ANDROID_LOG_INFO, kTag, "RIFE backend = %s",
                      g_rife_vulkan ? "vulkan" : "cpu");

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

extern "C" JNIEXPORT jstring JNICALL
Java_expo_modules_videoai_AiNativeEngine_nativeRifeBackend(JNIEnv* env, jobject) {
  std::lock_guard<std::mutex> lock(g_mutex);
  return env->NewStringUTF(g_rife ? (g_rife_vulkan ? "vulkan" : "cpu") : "none");
}

extern "C" JNIEXPORT void JNICALL
Java_expo_modules_videoai_AiNativeEngine_nativeSetTileSize(JNIEnv*, jobject, jint tile_size) {
  std::lock_guard<std::mutex> lock(g_mutex);
  g_tile_size = std::clamp(static_cast<int>(tile_size), kMinTileSize, kMaxTileSize);
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

  std::vector<unsigned char> enhanced;
  int output_width = 0;
  int output_height = 0;
  if (!run_super_resolution(input, kVideoScale, &enhanced, &output_width, &output_height) ||
      enhanced.empty() || g_cancelled.load()) {
    return nullptr;
  }
  return rgb_to_bitmap(env, enhanced.data(), output_width, output_height);
}

/**
 * 加载图片超分专用模型（realesr-general-x4v3，4x 通用降噪）。
 * 与视频引擎（2x + RIFE）互不干扰，可在视频引擎已初始化的情况下按需加载。
 */
bool load_image_engine(const std::string& model_dir, int scale) {
  g_last_error.clear();
  if (g_image_super_resolution) {
    g_image_super_resolution.reset();
  }
  if (!ensure_gpu()) {
    log_error("未检测到可用 Vulkan GPU");
    return false;
  }
  ncnn::VulkanDevice* vkdev = ncnn::get_gpu_device(0);
  if (!vkdev) {
    log_error("无法创建 NCNN Vulkan 设备");
    return false;
  }

  const std::string sr_param = model_dir + "/realesr-general-x4v3.param";
  const std::string sr_model = model_dir + "/realesr-general-x4v3.bin";
  if (!has_model_file(sr_param) || !has_model_file(sr_model)) {
    log_error("图片超分模型文件不完整（realesr-general-x4v3）");
    return false;
  }

  g_image_super_resolution = std::make_unique<ncnn::Net>();
  g_image_super_resolution->set_vulkan_device(vkdev);
  g_image_super_resolution->opt.use_vulkan_compute = true;
  g_image_super_resolution->opt.use_fp16_packed = true;
  g_image_super_resolution->opt.use_fp16_storage = true;
  g_image_super_resolution->opt.use_fp16_arithmetic = true;
  const int param_result = g_image_super_resolution->load_param(sr_param.c_str());
  const int model_result = param_result == 0
      ? g_image_super_resolution->load_model(sr_model.c_str())
      : param_result;
  if (param_result != 0 || model_result != 0) {
    const std::string message = "图片超分模型加载失败（param=" +
        std::to_string(param_result) + "，model=" + std::to_string(model_result) + "）";
    log_error(message.c_str());
    g_image_super_resolution.reset();
    return false;
  }

  g_image_scale = (scale == 2) ? 2 : 4;
  return true;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_expo_modules_videoai_AiNativeEngine_nativeLoadImageModel(JNIEnv* env, jobject,
                                                              jstring model_dir, jint scale) {
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
  return load_image_engine(path, static_cast<int>(scale)) ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jobject JNICALL
Java_expo_modules_videoai_AiNativeEngine_nativeUpscaleImage(JNIEnv* env, jobject, jobject bitmap) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (!g_image_super_resolution || !bitmap || g_cancelled.load()) return nullptr;
  try {
    std::vector<unsigned char> rgb;
    int width = 0;
    int height = 0;
    if (!bitmap_to_rgb(env, bitmap, &rgb, &width, &height)) return nullptr;
    ncnn::Mat input = ncnn::Mat::from_pixels(rgb.data(), ncnn::Mat::PIXEL_RGB, width, height);
    const float norm_vals[3] = {1.f / 255.f, 1.f / 255.f, 1.f / 255.f};
    input.substract_mean_normalize(nullptr, norm_vals);

    std::vector<unsigned char> enhanced;
    int output_width = 0;
    int output_height = 0;
    if (!run_image_super_resolution(input, &enhanced, &output_width, &output_height) ||
        enhanced.empty() || g_cancelled.load()) {
      return nullptr;
    }
    return rgb_to_bitmap(env, enhanced.data(), output_width, output_height);
  } catch (const std::exception& e) {
    log_error("图片超分处理失败（内存不足）");
    return nullptr;
  }
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

  // RIFE 不会自行分配 outimage，空的 Mat 会让写入走空指针导致 SIGSEGV，
  // 所以这里必须先准备好同尺寸的 RGB 缓冲。
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

  // 光流没收敛时输出会是鬼影，返回 null 让上层降级为复制前一帧
  if (!interpolation_is_sane(first_image, second_image, output)) {
    __android_log_print(ANDROID_LOG_WARN, kTag, "RIFE 输出异常，本帧降级为复制");
    return nullptr;
  }

  return rgb_to_bitmap(env, static_cast<const unsigned char*>(output.data), output.w, output.h);
}

extern "C" JNIEXPORT jdouble JNICALL
Java_expo_modules_videoai_AiNativeEngine_nativeMotionScore(JNIEnv* env, jobject, jobject first, jobject second) {
  if (!first || !second) return -1.0;

  AndroidBitmapInfo first_info{};
  AndroidBitmapInfo second_info{};
  void* first_pixels = nullptr;
  void* second_pixels = nullptr;
  if (AndroidBitmap_getInfo(env, first, &first_info) != ANDROID_BITMAP_RESULT_SUCCESS ||
      AndroidBitmap_getInfo(env, second, &second_info) != ANDROID_BITMAP_RESULT_SUCCESS ||
      first_info.format != ANDROID_BITMAP_FORMAT_RGBA_8888 ||
      second_info.format != ANDROID_BITMAP_FORMAT_RGBA_8888 ||
      first_info.width != second_info.width || first_info.height != second_info.height) {
    return -1.0;
  }
  if (AndroidBitmap_lockPixels(env, first, &first_pixels) != ANDROID_BITMAP_RESULT_SUCCESS ||
      !first_pixels) {
    return -1.0;
  }
  if (AndroidBitmap_lockPixels(env, second, &second_pixels) != ANDROID_BITMAP_RESULT_SUCCESS ||
      !second_pixels) {
    AndroidBitmap_unlockPixels(env, first);
    return -1.0;
  }

  const int width = static_cast<int>(first_info.width);
  const int height = static_cast<int>(first_info.height);
  const auto* a = static_cast<const unsigned char*>(first_pixels);
  const auto* b = static_cast<const unsigned char*>(second_pixels);
  constexpr int kStep = 8;
  double total = 0.0;
  double samples = 0.0;
  for (int row = 0; row < height; row += kStep) {
    const auto* a_row = a + static_cast<size_t>(row) * first_info.stride;
    const auto* b_row = b + static_cast<size_t>(row) * second_info.stride;
    for (int column = 0; column < width; column += kStep) {
      const double delta_red = static_cast<double>(a_row[column * 4]) -
          static_cast<double>(b_row[column * 4]);
      const double delta_green = static_cast<double>(a_row[column * 4 + 1]) -
          static_cast<double>(b_row[column * 4 + 1]);
      const double delta_blue = static_cast<double>(a_row[column * 4 + 2]) -
          static_cast<double>(b_row[column * 4 + 2]);
      total += std::fabs(delta_red) + std::fabs(delta_green) + std::fabs(delta_blue);
      samples += 3.0;
    }
  }

  AndroidBitmap_unlockPixels(env, second);
  AndroidBitmap_unlockPixels(env, first);
  return samples <= 0.0 ? -1.0 : total / samples;
}

/**
 * 把解码器输出的 YUV_420_888 直接转成 ARGB_8888 位图。
 *
 * 走 JNI 而不是 Java 逐像素，是因为逐像素在 1080p 上要跑两百万次循环，
 * 在导出流水线里会成为明显的热点。这里同时兼容 I420 与 NV12 两种平面布局：
 * U/V 平面的 pixelStride 与行/像素步长已经足以区分，无需特判。
 */
extern "C" JNIEXPORT jboolean JNICALL
Java_expo_modules_videoai_AiNativeEngine_nativeYuvToBitmap(
    JNIEnv* env, jobject,
    jobject y_plane, jint y_row_stride, jint y_pixel_stride,
    jobject u_plane, jint u_row_stride, jint u_pixel_stride,
    jobject v_plane, jint v_row_stride, jint v_pixel_stride,
    jint width, jint height,
    jobject bitmap) {
  PlaneView y;
  PlaneView u;
  PlaneView v;
  if (width <= 0 || height <= 0 || !bitmap ||
      !lock_plane(env, y_plane, &y) ||
      !lock_plane(env, u_plane, &u) ||
      !lock_plane(env, v_plane, &v)) {
    return JNI_FALSE;
  }
  if (y_row_stride <= 0 || y_pixel_stride <= 0 ||
      u_row_stride <= 0 || u_pixel_stride <= 0 ||
      v_row_stride <= 0 || v_pixel_stride <= 0) {
    log_error("YUV 平面步长非法");
    return JNI_FALSE;
  }

  // 越界保护：容量只需覆盖「本平面最后一个采样字节的偏移 + 1」。
  //
  // MediaCodec.getOutputImage() 返回的 MediaImage 平面缓冲是按裁剪区域
  // 精确切片的。NV12（U/V 交错，pixelStride=2）下色度区最后一个字节归属 V，
  // 因此 U 平面切片容量会比「整块色度区」少 1 字节
  // （实测 480x640 时 u.size=153599，而 320*480=153600）。
  // 用 (N-1)*pixelStride + 1 而不是 N*pixelStride 才是精确下界。
  const size_t chroma_rows = static_cast<size_t>((height + 1) / 2);
  const size_t y_samples = static_cast<size_t>(width);
  const size_t chroma_samples = static_cast<size_t>(width) / 2;
  const size_t y_needed = static_cast<size_t>(height - 1) * static_cast<size_t>(y_row_stride) +
      (y_samples - 1) * static_cast<size_t>(y_pixel_stride) + 1;
  const size_t u_needed = (chroma_rows - 1) * static_cast<size_t>(u_row_stride) +
      (chroma_samples - 1) * static_cast<size_t>(u_pixel_stride) + 1;
  const size_t v_needed = (chroma_rows - 1) * static_cast<size_t>(v_row_stride) +
      (chroma_samples - 1) * static_cast<size_t>(v_pixel_stride) + 1;
  if (y.size < y_needed || u.size < u_needed || v.size < v_needed) {
    log_error("YUV 平面数据长度不足");
    static bool yuv_debug_logged = false;
    if (!yuv_debug_logged) {
      yuv_debug_logged = true;
      __android_log_print(
          ANDROID_LOG_ERROR, kTag,
          "YUVBUF w=%d h=%d | size y=%llu u=%llu v=%llu | stride y=%d u=%d v=%d | "
          "pstride y=%d u=%d v=%d | need y=%llu u=%llu v=%llu",
          width, height,
          static_cast<unsigned long long>(y.size),
          static_cast<unsigned long long>(u.size),
          static_cast<unsigned long long>(v.size),
          y_row_stride, u_row_stride, v_row_stride,
          y_pixel_stride, u_pixel_stride, v_pixel_stride,
          static_cast<unsigned long long>(y_needed),
          static_cast<unsigned long long>(u_needed),
          static_cast<unsigned long long>(v_needed));
    }
    return JNI_FALSE;
  }

  AndroidBitmapInfo info{};
  void* pixels = nullptr;
  if (AndroidBitmap_getInfo(env, bitmap, &info) != ANDROID_BITMAP_RESULT_SUCCESS ||
      info.format != ANDROID_BITMAP_FORMAT_RGBA_8888 ||
      static_cast<int>(info.width) != width || static_cast<int>(info.height) != height) {
    log_error("YUV 转换目标必须是同尺寸的 ARGB_8888 位图");
    return JNI_FALSE;
  }
  if (AndroidBitmap_lockPixels(env, bitmap, &pixels) != ANDROID_BITMAP_RESULT_SUCCESS || !pixels) {
    return JNI_FALSE;
  }

  // BT.601 limited-range → RGB，系数按 Q16 定点化
  constexpr int kYScale = 76309;    // 1.164
  constexpr int kVToR = 104597;     // 1.596
  constexpr int kUToG = 25675;      // 0.391
  constexpr int kVToG = 53279;      // 0.813
  constexpr int kUToB = 132201;     // 2.018
  constexpr int kRound = 1 << 15;

  auto* destination = static_cast<unsigned char*>(pixels);
  for (int row = 0; row < height; ++row) {
    const unsigned char* y_row = y.data + static_cast<size_t>(row) * static_cast<size_t>(y_row_stride);
    const unsigned char* u_row = u.data + static_cast<size_t>(row / 2) * static_cast<size_t>(u_row_stride);
    const unsigned char* v_row = v.data + static_cast<size_t>(row / 2) * static_cast<size_t>(v_row_stride);
    unsigned char* destination_row = destination + static_cast<size_t>(row) * info.stride;

    for (int column = 0; column < width; ++column) {
      const int y_value = y_row[static_cast<size_t>(column) * static_cast<size_t>(y_pixel_stride)] - 16;
      const int u_value = u_row[static_cast<size_t>(column / 2) * static_cast<size_t>(u_pixel_stride)] - 128;
      const int v_value = v_row[static_cast<size_t>(column / 2) * static_cast<size_t>(v_pixel_stride)] - 128;
      const int scaled_y = kYScale * y_value;

      const int red = (scaled_y + kVToR * v_value + kRound) >> 16;
      const int green = (scaled_y - kUToG * u_value - kVToG * v_value + kRound) >> 16;
      const int blue = (scaled_y + kUToB * u_value + kRound) >> 16;

      destination_row[column * 4] = clamp_byte(red);
      destination_row[column * 4 + 1] = clamp_byte(green);
      destination_row[column * 4 + 2] = clamp_byte(blue);
      destination_row[column * 4 + 3] = 255;
    }
  }

  AndroidBitmap_unlockPixels(env, bitmap);
  return JNI_TRUE;
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
