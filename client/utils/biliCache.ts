import { Directory, File } from 'expo-file-system';
import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';

const PRIMARY_ROOT = '/storage/emulated/0';

const BILI_CACHE_ROOTS = [
  `${PRIMARY_ROOT}/Android/data/tv.danmaku.bili/download`,
  `${PRIMARY_ROOT}/tv.danmaku.bili/download`,
];

export const CONVERT_OUTPUT_DIR = `${PRIMARY_ROOT}/Movies/bilibili`;

interface BiliMuxerNativeInterface {
  readFileHead?: (path: string, length: number) => string;
  mergeMp4?: (
    videoPath: string,
    audioPath: string,
    outputPath: string,
    tag: string
  ) => Promise<boolean>;
}

const NativeBiliMuxer = NativeModules.BiliMuxer as
  | BiliMuxerNativeInterface
  | undefined;

export function isBiliConvertSupported(): boolean {
  return (
    Platform.OS === 'android' &&
    typeof NativeBiliMuxer?.mergeMp4 === 'function'
  );
}

export type BiliItemStatus =
  | 'ready'
  | 'video_only'
  | 'encrypted'
  | 'legacy_blv'
  | 'incomplete';

export const BILI_STATUS_LABELS: Record<BiliItemStatus, string> = {
  ready: '可导入',
  video_only: '仅画面',
  encrypted: '已加密',
  legacy_blv: '旧版FLV',
  incomplete: '不完整',
};

export interface BiliEpisode {
  id: string;
  title: string;
  part: string;
  qualityLabel: string | null;
  sizeBytes: number;
  status: BiliItemStatus;
  statusReason: string | null;
  videoUri: string | null;
  audioUri: string | null;
}

export interface BiliSeason {
  key: string;
  title: string;
  episodes: BiliEpisode[];
}

export interface BiliCacheOverview {
  rootsFound: string[];
  seasons: BiliSeason[];
}

const QUALITY_MAP: Record<string, string> = {
  '127': '8K',
  '126': '杜比',
  '125': 'HDR',
  '120': '4K',
  '116': '1080P60',
  '112': '1080P+',
  '100': '智能修复',
  '80': '1080P',
  '74': '720P60',
  '64': '720P',
  '48': '720P',
  '32': '480P',
  '16': '360P',
  '15': '360P',
};

interface EntryJsonShape {
  title?: unknown;
  type_tag?: unknown;
  total_bytes?: unknown;
  is_completed?: unknown;
  page_data?: { part?: unknown; page?: unknown } | null;
  ep?: {
    show_title?: unknown;
    long_title?: unknown;
    index?: unknown;
    title?: unknown;
  } | null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function listEntriesSafe(dir: Directory): (Directory | File)[] {
  try {
    if (!dir.exists) return [];
    return dir.list();
  } catch {
    return [];
  }
}

function fileSizeSafe(file: File): number {
  try {
    return file.exists ? file.size ?? 0 : 0;
  } catch {
    return 0;
  }
}

const B64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeBase64ToBytes(base64: string): Uint8Array | null {
  try {
    const clean = base64.replace(/[^a-z0-9+/]/gi, '');
    const usable = Math.floor(clean.length / 4) * 4;
    if (usable < 8) return null;
    const out = new Uint8Array((usable / 4) * 3);
    let outIndex = 0;
    for (let i = 0; i < usable; i += 4) {
      const sextets = [
        B64_ALPHABET.indexOf(clean[i]),
        B64_ALPHABET.indexOf(clean[i + 1]),
        B64_ALPHABET.indexOf(clean[i + 2]),
        B64_ALPHABET.indexOf(clean[i + 3]),
      ];
      if (sextets.some((v) => v < 0)) break;
      const value =
        (sextets[0] << 18) |
        (sextets[1] << 12) |
        (sextets[2] << 6) |
        sextets[3];
      out[outIndex++] = (value >> 16) & 0xff;
      out[outIndex++] = (value >> 8) & 0xff;
      out[outIndex++] = value & 0xff;
    }
    return out.subarray(0, outIndex);
  } catch {
    return null;
  }
}

function asciiAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0
  );
}

type HeadCheck = 'fmp4' | 'segment' | 'encrypted' | 'unknown';

function checkM4sHead(file: File): HeadCheck {
  if (typeof NativeBiliMuxer?.readFileHead !== 'function') return 'unknown';
  const head = NativeBiliMuxer.readFileHead(file.uri, 64);
  const bytes = decodeBase64ToBytes(head);
  if (!bytes || bytes.length < 8) return 'unknown';
  const boxType = asciiAt(bytes, 4);
  if (boxType === 'ftyp') return 'fmp4';
  if (boxType === 'styp') return 'segment';
  return 'encrypted';
}

function collectMediaFiles(
  dir: Directory,
  depth: number,
  videos: File[],
  audios: File[],
  blvs: File[]
): void {
  if (depth > 3) return;
  for (const entry of listEntriesSafe(dir)) {
    if (entry instanceof Directory) {
      collectMediaFiles(entry, depth + 1, videos, audios, blvs);
      continue;
    }
    if (!(entry instanceof File)) continue;
    const lowerName = entry.name.toLowerCase();
    if (lowerName.endsWith('.m4s')) {
      if (lowerName.includes('audio')) audios.push(entry);
      else if (lowerName.includes('video')) videos.push(entry);
    } else if (lowerName.endsWith('.blv')) {
      blvs.push(entry);
    }
  }
}

function parentFolderNameOf(dirUri: string): string {
  const trimmed = dirUri.replace(/\/+$/, '');
  const withoutName = trimmed.slice(0, trimmed.lastIndexOf('/'));
  const name = withoutName.slice(withoutName.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

async function parseEntryJson(file: File): Promise<EntryJsonShape | null> {
  try {
    if (!file.exists) return null;
    const raw = await file.text();
    return JSON.parse(raw) as EntryJsonShape;
  } catch {
    return null;
  }
}

function buildEpisode(
  episodeDir: Directory,
  entryJson: EntryJsonShape | null
): BiliEpisode {
  const folderTitle = parentFolderNameOf(episodeDir.uri);
  const seasonTitle =
    asString(entryJson?.title) ?? (folderTitle || episodeDir.name);

  const partCandidates = [
    asString(entryJson?.page_data?.part),
    asString(entryJson?.ep?.show_title),
    asString(entryJson?.ep?.long_title),
    asString(entryJson?.ep?.title),
  ];
  const pageNumber =
    typeof entryJson?.page_data?.page === 'number'
      ? entryJson.page_data.page
      : null;
  let part = partCandidates.find((candidate) => candidate !== null) ?? '';
  if (!part && pageNumber != null) part = `P${pageNumber}`;
  if (!part) part = '正片';

  const typeTag = asString(entryJson?.type_tag) ?? '';
  const qualityLabel = QUALITY_MAP[typeTag] ?? null;

  const videos: File[] = [];
  const audios: File[] = [];
  const blvs: File[] = [];
  collectMediaFiles(episodeDir, 0, videos, audios, blvs);

  let sizeBytes =
    typeof entryJson?.total_bytes === 'number' ? entryJson.total_bytes : 0;
  if (sizeBytes <= 0) {
    sizeBytes = [...videos, ...audios, ...blvs].reduce(
      (sum, file) => sum + fileSizeSafe(file),
      0
    );
  }

  const base = {
    id: `${seasonTitle}::${part}::${decodeURIComponent(episodeDir.uri)}`,
    title: seasonTitle,
    part,
    qualityLabel,
    sizeBytes,
  };

  const pickLargest = (files: File[]): File | null =>
    files.reduce<File | null>((best, file) => {
      if (!best || fileSizeSafe(file) > fileSizeSafe(best)) return file;
      return best;
    }, null);

  if (videos.length === 0 && blvs.length > 0) {
    return {
      ...base,
      status: 'legacy_blv',
      statusReason: '旧版FLV封装暂不支持，请使用新版客户端重新缓存',
      videoUri: null,
      audioUri: null,
    };
  }

  if (videos.length === 0) {
    return {
      ...base,
      status: 'incomplete',
      statusReason: '未找到视频流文件，缓存可能不完整',
      videoUri: null,
      audioUri: null,
    };
  }

  const videoFile = pickLargest(videos)!;
  const audioFile = audios.length > 0 ? pickLargest(audios) : null;

  const headCheck = checkM4sHead(videoFile);
  if (headCheck === 'encrypted') {
    return {
      ...base,
      status: 'encrypted',
      statusReason: '内容已加密，密钥与本机B站客户端绑定，无法解密',
      videoUri: null,
      audioUri: null,
    };
  }
  if (headCheck === 'segment') {
    return {
      ...base,
      status: 'incomplete',
      statusReason: '分片缺少moov元数据，缓存未完成或已损坏',
      videoUri: null,
      audioUri: null,
    };
  }
  if (headCheck === 'unknown') {
    return {
      ...base,
      status: 'incomplete',
      statusReason: '无法识别文件格式',
      videoUri: null,
      audioUri: null,
    };
  }

  return {
    ...base,
    status: audioFile ? 'ready' : 'video_only',
    statusReason: audioFile ? null : '未找到音频流，将只导出画面',
    videoUri: videoFile.uri,
    audioUri: audioFile?.uri ?? null,
  };
}

export async function getBiliCacheOverview(): Promise<BiliCacheOverview> {
  const rootsFound: string[] = [];
  const seasons = new Map<string, BiliSeason>();

  const queue: Array<{ dir: Directory; depth: number }> = [];
  for (const rootPath of BILI_CACHE_ROOTS) {
    const root = new Directory(rootPath);
    if (!root.exists) continue;
    rootsFound.push(rootPath);
    queue.push({ dir: root, depth: 0 });
  }

  const visited = new Set<string>();
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    const dirKey = dir.uri.toLowerCase();
    if (visited.has(dirKey)) continue;
    visited.add(dirKey);

    const entries = listEntriesSafe(dir);
    const hasEntryJson = entries.some(
      (entry) => entry instanceof File && entry.name === 'entry.json'
    );

    if (hasEntryJson) {
      const entryFile = entries.find(
        (entry): entry is File => entry instanceof File && entry.name === 'entry.json'
      )!;
      const parsed = await parseEntryJson(entryFile);
      const episode = buildEpisode(dir, parsed);
      let season = seasons.get(episode.title);
      if (!season) {
        season = { key: episode.title, title: episode.title, episodes: [] };
        seasons.set(episode.title, season);
      }
      if (!season.episodes.some((item) => item.id === episode.id)) {
        season.episodes.push(episode);
      }
      continue;
    }

    if (depth >= 4) continue;
    for (const entry of entries) {
      if (entry instanceof Directory && !entry.name.startsWith('.')) {
        queue.push({ dir: entry, depth: depth + 1 });
      }
    }
  }

  const seasonList = Array.from(seasons.values());
  for (const season of seasonList) {
    season.episodes.sort((a, b) => a.part.localeCompare(b.part, 'zh-Hans-CN', { numeric: true }));
  }
  seasonList.sort((a, b) => b.episodes.length - a.episodes.length);

  return { rootsFound, seasons: seasonList };
}

function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 100 ? cleaned.slice(0, 100).trim() : cleaned;
}

function resolveUniqueOutput(title: string, part: string): File {
  const outputDir = new Directory(CONVERT_OUTPUT_DIR);
  if (!outputDir.exists) {
    outputDir.create({ idempotent: true });
  }
  const baseName = sanitizeFilename(`${title} ${part}`);
  let candidate = `${baseName}.mp4`;
  let counter = 2;
  while (new File(outputDir, candidate).exists) {
    candidate = `${baseName} (${counter}).mp4`;
    counter += 1;
  }
  return new File(outputDir, candidate);
}

export interface BiliConvertProgress {
  doneCount: number;
  totalCount: number;
  currentTitle: string;
  itemFraction: number;
}

export interface BiliConvertFailure {
  episode: BiliEpisode;
  reason: string;
}

export interface BiliConvertResult {
  succeeded: BiliEpisode[];
  failed: BiliConvertFailure[];
  cancelled: boolean;
}

export interface BiliConvertHandle {
  cancelled: boolean;
}

export async function convertEpisodes(
  episodes: BiliEpisode[],
  options: {
    handle?: BiliConvertHandle;
    onProgress?: (progress: BiliConvertProgress) => void;
  } = {}
): Promise<BiliConvertResult> {
  const { handle, onProgress } = options;
  const result: BiliConvertResult = {
    succeeded: [],
    failed: [],
    cancelled: false,
  };

  if (!isBiliConvertSupported()) {
    return result;
  }

  let progressSubscription: { remove: () => void } | null = null;
  let activeTag = '';
  let activeFraction = 0;

  try {
    progressSubscription = DeviceEventEmitter.addListener(
      'BiliMergeProgress',
      (event: { tag?: string; bytes?: number; total?: number }) => {
        if (!event || event.tag !== activeTag) return;
        const bytes = typeof event.bytes === 'number' ? event.bytes : 0;
        const total = typeof event.total === 'number' ? event.total : 0;
        activeFraction = total > 0 ? Math.min(bytes / total, 1) : 0;
      }
    );

    for (let index = 0; index < episodes.length; index += 1) {
      if (handle?.cancelled) {
        result.cancelled = true;
        break;
      }
      const episode = episodes[index];
      activeTag = episode.id;
      activeFraction = 0;

      const report = () =>
        onProgress?.({
          doneCount: index,
          totalCount: episodes.length,
          currentTitle: `${episode.title} ${episode.part}`,
          itemFraction: activeFraction,
        });
      report();

      if (!episode.videoUri) {
        result.failed.push({
          episode,
          reason: episode.statusReason ?? '缺少视频流',
        });
        continue;
      }

      try {
        const output = resolveUniqueOutput(episode.title, episode.part);
        await NativeBiliMuxer!.mergeMp4!(
          episode.videoUri,
          episode.audioUri ?? '',
          output.uri,
          episode.id
        );
        result.succeeded.push(episode);
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : '合成失败';
        result.failed.push({ episode, reason: message });
      }
    }
  } finally {
    progressSubscription?.remove();
    onProgress?.({
      doneCount: result.succeeded.length + result.failed.length,
      totalCount: episodes.length,
      currentTitle: '',
      itemFraction: 0,
    });
  }

  return result;
}
