/**
 * 媒体缩略图缓存工具
 *
 * 配合 native StorageAccess.getThumbnail / prepareThumbnails 使用：
 * - 命中缓存：同步返回 file:// 缩略图路径（Map 内存缓存 + native 磁盘缓存双层）
 * - 未命中：native 返回 null 并在后台线程解码生成，完成后通过
 *   onThumbnailReady 事件通知，此时再调 getThumbnailSync 即可同步命中
 * - 预热：扫描完成后批量投递，后台串行解码，越用越顺
 */
import { DeviceEventEmitter } from 'react-native';
import { NativeModules } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';

const NativeStorageAccess = NativeModules.StorageAccess as
  | {
      getThumbnail?: (sourceUri: string, targetSize: number) => string | null;
      prepareThumbnails?: (sources: string[], targetSize: number) => void;
    }
  | undefined;

const DEFAULT_THUMB_SIZE = 512;
const THUMB_DIR = 'media_thumbs';

// 内存级缓存：sourceUri -> thumbUri
const memoryCache = new Map<string, string>();
const listeners = new Set<(sourceUri: string, thumbUri: string) => void>();

let subscribed = false;

function ensureSubscription() {
  if (subscribed) return;
  subscribed = true;
  DeviceEventEmitter.addListener('onThumbnailReady', (sourceUri: string) => {
    // native 只带 sourceUri；此时磁盘缓存已生成，同步调用必然命中
    const thumbUri = getThumbnailSync(sourceUri);
    if (thumbUri) {
      memoryCache.set(sourceUri, thumbUri);
      listeners.forEach((listener) => listener(sourceUri, thumbUri));
    }
  });
}

/**
 * 同步取缩略图：命中返回缩略图 file:// 路径；未命中返回 null
 * （副作用：未命中时会触发 native 后台解码，完成后经事件刷新）
 */
export function getThumbnailSync(sourceUri: string, targetSize = DEFAULT_THUMB_SIZE): string | null {
  if (!NativeStorageAccess?.getThumbnail || !sourceUri) return null;
  const hit = memoryCache.get(sourceUri);
  if (hit) return hit;
  try {
    const result = NativeStorageAccess.getThumbnail(sourceUri, targetSize);
    if (result) {
      memoryCache.set(sourceUri, result);
      return result;
    }
  } catch {
    // native 调用异常按未命中处理
  }
  return null;
}

/** 订阅缩略图就绪事件，返回取消订阅函数 */
export function subscribeThumbnails(
  listener: (sourceUri: string, thumbUri: string) => void
): () => void {
  ensureSubscription();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 批量预热（fire and forget）：native 后台串行解码，已缓存自动跳过，无返回（v2.0.3 起 native 弃用 Promise） */
export function prepareThumbnails(sources: string[], targetSize = DEFAULT_THUMB_SIZE): void {
  try {
    NativeStorageAccess?.prepareThumbnails?.(sources, targetSize);
  } catch {
    // 预热失败无感
  }
}

/** 查询缩略图磁盘缓存总大小（字节） */
export function getThumbnailCacheSize(): number {
  try {
    const dir = new Directory(Paths.cache, THUMB_DIR);
    if (!dir.exists) return 0;
    let total = 0;
    for (const entry of dir.list()) {
      if (entry instanceof File) total += entry.size ?? 0;
    }
    return total;
  } catch {
    return 0;
  }
}

/** 清空缩略图磁盘缓存与内存缓存 */
export function clearThumbnailCache(): boolean {
  try {
    const dir = new Directory(Paths.cache, THUMB_DIR);
    if (dir.exists) dir.delete();
    memoryCache.clear();
    return true;
  } catch {
    return false;
  }
}
