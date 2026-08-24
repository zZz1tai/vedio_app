import { Directory, File } from 'expo-file-system';

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
const MAX_RESULTS = 3000;
const TIME_BUDGET_MS = 15000;

export interface ScannedVideo {
  uri: string;
  filename: string;
  size: number;
  modificationTime: number;
}

export async function hasAllFilesAccess(): Promise<boolean> {
  try {
    const root = new Directory(PRIMARY_STORAGE_ROOT);
    if (!root.exists) return false;
    return root.list().length > 0;
  } catch {
    return false;
  }
}

export async function scanDeviceForVideos(
  onProgress?: (count: number) => void
): Promise<ScannedVideo[]> {
  const results: ScannedVideo[] = [];
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
      if (!VIDEO_EXTENSIONS.has(extension)) continue;

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
