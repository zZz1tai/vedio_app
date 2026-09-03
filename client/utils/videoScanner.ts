import { Directory, File } from 'expo-file-system';
import { NativeModules, Platform } from 'react-native';

const NativeStorageAccess = NativeModules.StorageAccess as
  | {
      isAllFilesAccessGranted?: () => boolean;
      renameFile?: (sourceUri: string, targetUri: string) => boolean;
    }
  | undefined;

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mkv',
  '.webm',
  '.avi',
  '.mov',
  '.flv',
  '.wmv',
  '.m4v',
  '.3gp',
  '.3g2',
  '.mpg',
  '.mpeg',
  '.ts',
  '.m2ts',
  '.mts',
  '.vob',
  '.ogv',
  '.rmvb',
  '.rm',
  '.asf',
  '.divx',
  '.f4v',
]);

const PHOTO_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.jpe',
  '.jfif',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.heic',
  '.heif',
  '.avif',
  '.tiff',
  '.tif',
  '.ico',
  '.svg',
]);

const SKIP_DIR_NAMES = new Set([
  'android',
  'lost.dir',
  '$recycle.bin',
  'system volume information',
  'alldata_backup',
  'miui_backup',
  'backup',
  'download_backup',
]);

const PRIMARY_STORAGE_ROOT = '/storage/emulated/0';
const MAX_DEPTH = 8;
/**
 * 结果上限保险值：真正限制是 TIME_BUDGET_MS 扫描预算。
 * 手机相册上万张图很常见（微信/抖音目录动辄几千），
 * 列表由 FlatList 虚拟化渲染，data 量 2 万条内内存与渲染均无压力。
 */
const MAX_RESULTS = 20000;
const TIME_BUDGET_MS = 15000;

export interface ScannedVideo {
  uri: string;
  filename: string;
  size: number;
  modificationTime: number;
}

export interface ScannedPhoto {
  uri: string;
  filename: string;
  size: number;
  modificationTime: number;
}

const WRITE_PROBE_DIR_NAMES = ['Download', 'DCIM', 'Pictures'];

export async function hasAllFilesAccess(): Promise<boolean> {
  try {
    if (
      Platform.OS === 'android' &&
      typeof NativeStorageAccess?.isAllFilesAccessGranted === 'function'
    ) {
      return NativeStorageAccess.isAllFilesAccessGranted();
    }

    const root = new Directory(PRIMARY_STORAGE_ROOT);
    if (!root.exists) return false;

    let entries: (Directory | File)[];
    try {
      entries = root.list();
    } catch {
      return false;
    }
    if (entries.length === 0) return false;

    for (const name of WRITE_PROBE_DIR_NAMES) {
      const candidate = new Directory(root, name);
      if (!candidate.exists) continue;
      try {
        candidate.create({ idempotent: true });
        return true;
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function renameVideoFile(sourceUri: string, targetUri: string): boolean {
  if (typeof NativeStorageAccess?.renameFile === 'function') {
    return NativeStorageAccess.renameFile(sourceUri, targetUri);
  }
  try {
    const dirUri = targetUri.slice(0, targetUri.lastIndexOf('/'));
    const newName = targetUri.slice(targetUri.lastIndexOf('/') + 1);
    new File(sourceUri).move(new File(dirUri, newName));
    return true;
  } catch {
    return false;
  }
}

interface ScannedFile {
  uri: string;
  filename: string;
  size: number;
  modificationTime: number;
}

async function scanByExtensions(
  extensions: Set<string>,
  onProgress?: (count: number) => void
): Promise<ScannedFile[]> {
  const results: ScannedFile[] = [];
  const startedAt = Date.now();
  const queue: Array<{ dir: Directory; depth: number }> = [
    { dir: new Directory(PRIMARY_STORAGE_ROOT), depth: 0 },
  ];

  while (queue.length > 0) {
    if (results.length >= MAX_RESULTS) break;
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;

    const { dir, depth } = queue.shift()!;

    let entries: (Directory | File)[];
    try {
      entries = dir.list();
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (results.length >= MAX_RESULTS) break;
      if (Date.now() - startedAt > TIME_BUDGET_MS) break;

      const lowerName = entry.name.toLowerCase();

      if (entry instanceof Directory) {
        if (depth >= MAX_DEPTH) continue;
        if (SKIP_DIR_NAMES.has(lowerName) || lowerName.startsWith('.')) continue;
        queue.push({ dir: entry, depth: depth + 1 });
        continue;
      }

      if (!(entry instanceof File)) continue;

      const extension = entry.extension.toLowerCase();
      if (!extensions.has(extension)) continue;

      try {
        if (!entry.exists) continue;
        results.push({
          uri: entry.uri,
          filename: entry.name,
          size: entry.size ?? 0,
          modificationTime: entry.modificationTime ?? 0,
        });
        onProgress?.(results.length);
      } catch {
        continue;
      }
    }
  }

  return results;
}

export async function scanDeviceForVideos(
  onProgress?: (count: number) => void
): Promise<ScannedVideo[]> {
  return scanByExtensions(VIDEO_EXTENSIONS, onProgress);
}

export async function scanDeviceForPhotos(
  onProgress?: (count: number) => void
): Promise<ScannedPhoto[]> {
  return scanByExtensions(PHOTO_EXTENSIONS, onProgress);
}
