/**
 * 首页共享常量、类型与纯工具函数
 *
 * 从 home/index.tsx 拆出：原文件 1904 行、单组件 1132 行、14 个 useState，
 * 改动任何 tab 都要在巨型文件里精准落点。此处承载与视图无关的部分，便于复用与单测。
 */
import React from 'react';
import { Dimensions, Text } from 'react-native';
import type { ThemePreference } from '@/contexts/ThemeContext';

export const { width: screenWidth } = Dimensions.get('window');
export const GRID_GAP = 12;
export const GRID_COLUMNS = 2;
export const CARD_WIDTH = (screenWidth - GRID_GAP * 3) / 2;
export const PHOTO_COLUMNS = 3;
export const PHOTO_COLUMN_OPTIONS = [2, 3, 4, 5, 6, 7, 8, 10, 12] as const;
export const PHOTO_COLUMN_MIN = PHOTO_COLUMN_OPTIONS[0];
export const PHOTO_COLUMN_MAX = PHOTO_COLUMN_OPTIONS[PHOTO_COLUMN_OPTIONS.length - 1];
export const PHOTO_COLUMNS_STORAGE_KEY = 'app.photo.gridColumns';

export interface VideoItem {
  id: string;
  uri: string;
  filename: string;
  duration: number;
  width: number;
  height: number;
  fileSize: number;
  modificationTime: number;
  mimeType: string;
}

export interface PhotoItem {
  id: string;
  uri: string;
  filename: string;
  width: number;
  height: number;
  modificationTime: number;
  fileSize: number;
}

export type HomeTab = 'video' | 'photo';

export const toMilliseconds = (value: number) => (value > 1e12 ? value : value * 1000);

export const normalizePath = (uri: string) =>
  uri.replace(/^file:\/\//, '').toLowerCase();

export function decodeUriPath(uri: string): string {
  if (!uri.startsWith('file://')) return '';
  const rawPath = uri.slice('file://'.length);
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
}

export const searchHaystackCache = new WeakMap<VideoItem, string>();

export function getSearchHaystack(video: VideoItem): string {
  let cached = searchHaystackCache.get(video);
  if (cached === undefined) {
    cached = `${video.filename}\n${decodeUriPath(video.uri)}`.toLowerCase();
    searchHaystackCache.set(video, cached);
  }
  return cached;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function renderHighlightedFilename(
  text: string,
  tokens: string[],
  accentColor: string
): React.ReactNode[] {
  if (tokens.length === 0) return [text];
  const pattern = tokens.map(escapeRegExp).join('|');
  const parts = text.split(new RegExp(`(${pattern})`, 'gi'));
  return parts.map((part, index) =>
    tokens.indexOf(part.toLowerCase()) !== -1 ? (
      <Text key={index} style={{ color: accentColor }}>
        {part}
      </Text>
    ) : (
      <React.Fragment key={index}>{part}</React.Fragment>
    )
  );
}

export interface VideoGroup {
  key: string;
  title: string;
  data: VideoItem[];
}

export interface VideoSection {
  key: string;
  title: string;
  data: VideoItem[][];
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export const SOURCE_LABELS: Record<string, string> = {
  camera: '相机',
  dcim: '相机',
  screenshots: '截屏',
  screenrecorder: '录屏',
  download: '下载',
  downloads: '下载',
  douyin: '抖音',
  tiktok: '抖音',
  bilibili: '哔哩哔哩',
  qqlive: '腾讯视频',
  tencent: '腾讯',
  weixin: '微信',
  wechat: '微信',
  weibo: '微博',
  kwai: '快手',
  kuaishou: '快手',
  iqiyi: '爱奇艺',
  youku: '优酷',
  xigua: '西瓜视频',
  movies: '电影',
  video: '视频',
  videos: '视频',
  music: '音频',
  pictures: '图片',
};

export function resolveSourceLabel(uri: string): { key: string; title: string } {
  const path = decodeURIComponent(normalizePath(uri));
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) {
    return { key: 'other', title: '其他' };
  }

  for (let i = segments.length - 2; i >= Math.max(1, segments.length - 4); i--) {
    const segment = segments[i];
    const known = SOURCE_LABELS[segment];
    if (known) {
      return { key: `known:${segment}`, title: known };
    }
  }

  const parent = segments[segments.length - 2];
  return { key: `dir:${parent}`, title: parent };
}

export function resolveDateBucket(modificationTime: number): { key: string; title: string } {
  if (!modificationTime) {
    return { key: 'unknown', title: '未知时间' };
  }
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  ).getTime();
  const time = toMilliseconds(modificationTime);

  if (time >= startOfToday) return { key: 'today', title: '今天' };
  if (time >= startOfToday - 86400000) return { key: 'yesterday', title: '昨天' };
  if (time >= startOfToday - 7 * 86400000) return { key: 'week', title: '7 天内' };
  if (time >= startOfToday - 30 * 86400000) return { key: 'month', title: '30 天内' };
  return { key: 'earlier', title: '更早' };
}

export const DATE_BUCKET_ORDER = ['today', 'yesterday', 'week', 'month', 'earlier', 'unknown'];

export interface ThemePalette {
  background: string;
  foreground: string;
  surface: string;
  muted: string;
  border: string;
  accent: string;
  accentSoft: string;
  accentForeground: string;
  backgroundTertiary: string;
  danger: string;
  dangerSoft: string;
}

export const THEME_CYCLE_ORDER: ThemePreference[] = ['system', 'light', 'dark'];
