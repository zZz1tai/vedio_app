import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  SectionList,
  TouchableOpacity,
  ActivityIndicator,
  Dimensions,
  Linking,
  Platform,
  StyleSheet,
  TextInput,
  Modal,
  AppState,
  Keyboard,
  Image,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as MediaLibrary from 'expo-media-library';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Application from 'expo-application';
import { Screen } from '@/components/Screen';
import { VideoThumbnail } from '@/components/VideoThumbnail';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useFocusEffect } from 'expo-router';
import { formatFileSize, formatDuration, getQualityLabel } from '@/utils/format';
import {
  hasAllFilesAccess,
  renameVideoFile,
  scanDeviceForVideos,
  scanDeviceForPhotos,
} from '@/utils/videoScanner';
import { useCSSVariable } from 'uniwind';
import { useThemePreference, type ThemePreference } from '@/contexts/ThemeContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

const { width: screenWidth } = Dimensions.get('window');
const GRID_GAP = 12;
const GRID_COLUMNS = 2;
const CARD_WIDTH = (screenWidth - GRID_GAP * 3) / 2;
const PHOTO_COLUMNS = 3;
const PHOTO_COLUMN_OPTIONS = [2, 3, 4, 5, 6, 7, 8, 10, 12] as const;
const PHOTO_COLUMN_MIN = PHOTO_COLUMN_OPTIONS[0];
const PHOTO_COLUMN_MAX = PHOTO_COLUMN_OPTIONS[PHOTO_COLUMN_OPTIONS.length - 1];
const PHOTO_COLUMNS_STORAGE_KEY = 'app.photo.gridColumns';

interface VideoItem {
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

interface PhotoItem {
  id: string;
  uri: string;
  filename: string;
  width: number;
  height: number;
  modificationTime: number;
  fileSize: number;
}

type HomeTab = 'video' | 'photo';

const toMilliseconds = (value: number) => (value > 1e12 ? value : value * 1000);

const normalizePath = (uri: string) =>
  uri.replace(/^file:\/\//, '').toLowerCase();

function decodeUriPath(uri: string): string {
  if (!uri.startsWith('file://')) return '';
  const rawPath = uri.slice('file://'.length);
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
}

const searchHaystackCache = new WeakMap<VideoItem, string>();

function getSearchHaystack(video: VideoItem): string {
  let cached = searchHaystackCache.get(video);
  if (cached === undefined) {
    cached = `${video.filename}\n${decodeUriPath(video.uri)}`.toLowerCase();
    searchHaystackCache.set(video, cached);
  }
  return cached;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderHighlightedFilename(
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

interface VideoGroup {
  key: string;
  title: string;
  data: VideoItem[];
}

interface VideoSection {
  key: string;
  title: string;
  data: VideoItem[][];
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

const SOURCE_LABELS: Record<string, string> = {
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

function resolveSourceLabel(uri: string): { key: string; title: string } {
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

function resolveDateBucket(modificationTime: number): { key: string; title: string } {
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

const DATE_BUCKET_ORDER = ['today', 'yesterday', 'week', 'month', 'earlier', 'unknown'];

interface ThemePalette {
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

const THEME_CYCLE_ORDER: ThemePreference[] = ['system', 'light', 'dark'];

export default function HomeScreen() {
  const router = useSafeRouter();
  const insets = useSafeAreaInsets();
  const { preference, setPreference: setThemePreference } = useThemePreference();
  const [
    background,
    foreground,
    surface,
    muted,
    borderToken,
    accent,
    accentSoft,
    accentForeground,
    backgroundTertiary,
    danger,
    dangerSoft,
  ] = useCSSVariable([
    '--color-background',
    '--color-foreground',
    '--color-surface',
    '--color-muted',
    '--color-border',
    '--color-accent',
    '--color-accent-soft',
    '--color-accent-foreground',
    '--color-background-tertiary',
    '--color-danger',
    '--color-danger-soft',
  ]) as string[];

  const c: ThemePalette = {
    background,
    foreground,
    surface,
    muted,
    border: borderToken,
    accent,
    accentSoft,
    accentForeground,
    backgroundTertiary,
    danger,
    dangerSoft,
  };

  const styles = useMemo(() => createStyles(c), [
    background,
    foreground,
    surface,
    muted,
    borderToken,
    accent,
    accentSoft,
    accentForeground,
    backgroundTertiary,
    danger,
    dangerSoft,
  ]);

  const statusBarStyle = preference === 'light' ? 'dark' : 'light';

  const handleCycleTheme = useCallback(() => {
    const next =
      THEME_CYCLE_ORDER[(THEME_CYCLE_ORDER.indexOf(preference) + 1) % THEME_CYCLE_ORDER.length];
    setThemePreference(next);
  }, [preference, setThemePreference]);

  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [permissionCanAskAgain, setPermissionCanAskAgain] = useState(true);
  const [hasInitialized, setHasInitialized] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [grouped, setGrouped] = useState(false);
  const [groupBy, setGroupBy] = useState<'folder' | 'date'>('folder');
  const [searchDraft, setSearchDraft] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [renameTarget, setRenameTarget] = useState<VideoItem | null>(null);
  const [renameText, setRenameText] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [allFilesAccessGranted, setAllFilesAccessGranted] = useState(true);
  const pendingAllFilesRecheck = useRef(false);
  const [activeTab, setActiveTab] = useState<HomeTab>('video');
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [scanCount, setScanCount] = useState(0);
  const [photoSearch, setPhotoSearch] = useState('');
  const [photoColumns, setPhotoColumns] = useState<number>(PHOTO_COLUMNS);
  const [gridPickerOpen, setGridPickerOpen] = useState(false);
  const photoColumnsRef = useRef(PHOTO_COLUMNS);
  const pinchBaseRef = useRef(PHOTO_COLUMNS);

  const isSearching = searchQuery.length > 0;
  const searchTokens = useMemo(() => {
    if (!isSearching) return [];
    return searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
  }, [isSearching, searchQuery]);
  const filteredVideos = useMemo(() => {
    if (searchTokens.length === 0) return videos;
    return videos.filter((video) => {
      const haystack = getSearchHaystack(video);
      return searchTokens.every((token) => haystack.includes(token));
    });
  }, [videos, searchTokens]);

  const videoGroups = useMemo<VideoGroup[]>(() => {
    if (searchTokens.length > 0) return [];
    const buckets = new Map<string, VideoGroup>();

    for (const video of filteredVideos) {
      const resolved =
        groupBy === 'folder'
          ? resolveSourceLabel(video.uri)
          : resolveDateBucket(video.modificationTime);
      let bucket = buckets.get(resolved.key);
      if (!bucket) {
        bucket = { key: resolved.key, title: resolved.title, data: [] };
        buckets.set(resolved.key, bucket);
      }
      bucket.data.push(video);
    }

    const groups = Array.from(buckets.values());
    if (groupBy === 'date') {
      groups.sort(
        (a, b) =>
          DATE_BUCKET_ORDER.indexOf(a.key) - DATE_BUCKET_ORDER.indexOf(b.key)
      );
    } else {
      groups.sort((a, b) => b.data.length - a.data.length || a.title.localeCompare(b.title));
    }
    for (const group of groups) {
      group.data.sort(
        (a, b) => toMilliseconds(b.modificationTime) - toMilliseconds(a.modificationTime)
      );
    }
    return groups;
  }, [filteredVideos, groupBy, searchTokens]);

  const groupedSections = useMemo<VideoSection[]>(
    () =>
      videoGroups.map((section) => ({
        ...section,
        data: chunkArray(section.data, viewMode === 'grid' ? GRID_COLUMNS : 1),
      })),
    [videoGroups, viewMode]
  );

  const requestPermission = useCallback(async () => {
    try {
      const permission = await MediaLibrary.requestPermissionsAsync();
      const granted = permission.status === 'granted';
      setPermissionGranted(granted);
      setPermissionCanAskAgain(permission.canAskAgain);
      return granted;
    } catch {
      setPermissionGranted(false);
      return false;
    }
  }, []);

  const refreshPermission = useCallback(async () => {
    try {
      const permission = await MediaLibrary.getPermissionsAsync();
      const granted = permission.status === 'granted';
      setPermissionGranted(granted);
      setPermissionCanAskAgain(permission.canAskAgain);
      return granted;
    } catch {
      setPermissionGranted(false);
      return false;
    }
  }, []);

  const loadVideos = useCallback(async () => {
    try {
      setLoading(true);

      // 媒体库单次最多返回 500 条，用 after 游标分页拉全（上限 5000 条防极端）
      const videoItems: VideoItem[] = [];
      let after: string | undefined;
      const MEDIA_LIBRARY_PAGE = 500;
      const MEDIA_LIBRARY_LIMIT = 5000;
      do {
        const page = await MediaLibrary.getAssetsAsync({
          mediaType: 'video',
          sortBy: ['modificationTime'],
          first: MEDIA_LIBRARY_PAGE,
          after,
        });
        for (const asset of page.assets) {
          videoItems.push({
            id: asset.id,
            uri: asset.uri,
            filename: asset.filename || 'Unknown',
            duration: asset.duration || 0,
            width: asset.width || 0,
            height: asset.height || 0,
            fileSize: 0,
            modificationTime: asset.modificationTime || 0,
            mimeType: '',
          });
        }
        after = page.endCursor ?? undefined;
        if (!page.hasNextPage) break;
      } while (videoItems.length < MEDIA_LIBRARY_LIMIT);

      const deepAccessGranted = await hasAllFilesAccess();
      setAllFilesAccessGranted(deepAccessGranted);

      if (deepAccessGranted) {
        const scanned = await scanDeviceForVideos();
        const seenPaths = new Set(videoItems.map((item) => normalizePath(item.uri)));

        for (const item of scanned) {
          const pathKey = normalizePath(item.uri);
          if (seenPaths.has(pathKey)) continue;
          seenPaths.add(pathKey);

          videoItems.push({
            id: `fs:${pathKey}`,
            uri: item.uri,
            filename: item.filename,
            duration: 0,
            width: 0,
            height: 0,
            fileSize: item.size,
            modificationTime: toMilliseconds(item.modificationTime),
            mimeType: '',
          });
        }

        videoItems.sort(
          (a, b) => toMilliseconds(b.modificationTime) - toMilliseconds(a.modificationTime)
        );
      }

      setVideos(videoItems);
    } catch (error) {
      console.error('Failed to load videos:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPhotos = useCallback(async () => {
    try {
      setPhotosLoading(true);
      setScanCount(0);
      // 媒体库单次最多返回 500 条，用 after 游标分页拉全（上限 5000 张防极端）
      const photoItems: PhotoItem[] = [];
      let after: string | undefined;
      const MEDIA_LIBRARY_PAGE = 500;
      const MEDIA_LIBRARY_LIMIT = 5000;
      do {
        const page = await MediaLibrary.getAssetsAsync({
          mediaType: 'photo',
          sortBy: ['modificationTime'],
          first: MEDIA_LIBRARY_PAGE,
          after,
        });
        for (const asset of page.assets) {
          photoItems.push({
            id: asset.id,
            uri: asset.uri,
            filename: asset.filename || 'Unknown',
            width: asset.width || 0,
            height: asset.height || 0,
            modificationTime: asset.modificationTime || 0,
            fileSize: 0,
          });
        }
        after = page.endCursor ?? undefined;
        if (!page.hasNextPage) break;
      } while (photoItems.length < MEDIA_LIBRARY_LIMIT);

      const deepAccessGranted = await hasAllFilesAccess();
      setAllFilesAccessGranted(deepAccessGranted);

      if (deepAccessGranted) {
        // onProgress 每张都回调，UI 节流到每 100 张更新一次避免频繁重渲染
        let lastReported = 0;
        const scanned = await scanDeviceForPhotos((count) => {
          if (count - lastReported >= 100) {
            lastReported = count;
            setScanCount(count);
          }
        });
        const seenPaths = new Set(photoItems.map((item) => normalizePath(item.uri)));

        for (const item of scanned) {
          const pathKey = normalizePath(item.uri);
          if (seenPaths.has(pathKey)) continue;
          seenPaths.add(pathKey);

          photoItems.push({
            id: `fs:${pathKey}`,
            uri: item.uri,
            filename: item.filename,
            width: 0,
            height: 0,
            fileSize: item.size,
            modificationTime: toMilliseconds(item.modificationTime),
          });
        }

        photoItems.sort(
          (a, b) => toMilliseconds(b.modificationTime) - toMilliseconds(a.modificationTime)
        );
      }

      setPhotos(photoItems);
    } catch (error) {
      console.error('Failed to load photos:', error);
    } finally {
      setPhotosLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(PHOTO_COLUMNS_STORAGE_KEY)
      .then((raw) => {
        if (!mounted) return;
        const value = Number(raw);
        if (PHOTO_COLUMN_OPTIONS.includes(value as (typeof PHOTO_COLUMN_OPTIONS)[number])) {
          setPhotoColumns(value);
          photoColumnsRef.current = value;
        }
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const init = async () => {
      const granted = await requestPermission();
      if (granted) {
        await Promise.all([loadVideos(), loadPhotos()]);
      } else {
        setLoading(false);
      }
      setHasInitialized(true);
    };
    init();
  }, [requestPermission, loadVideos, loadPhotos]);

  useFocusEffect(
    useCallback(() => {
      if (!hasInitialized) return;

      let isActive = true;
      const refreshVideos = async () => {
        const granted = await refreshPermission();
        if (isActive && granted) {
          await Promise.all([loadVideos(), loadPhotos()]);
        }
      };
      refreshVideos();

      return () => {
        isActive = false;
      };
    }, [hasInitialized, loadVideos, loadPhotos, refreshPermission])
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !pendingAllFilesRecheck.current) return;
      pendingAllFilesRecheck.current = false;
      if (!permissionGranted) return;
      loadVideos();
    });
    return () => subscription.remove();
  }, [loadVideos, permissionGranted]);

  const handlePlayVideo = useCallback(
    (video: VideoItem) => {
      router.push('/player', {
        uri: video.uri,
        title: video.filename,
        duration: video.duration,
      });
    },
    [router]
  );

  const handleOpenPhoto = useCallback(
    (photo: PhotoItem) => {
      router.push('/image-upscale', {
        uri: photo.uri,
        title: photo.filename,
        width: photo.width,
        height: photo.height,
      });
    },
    [router]
  );

  const applyPhotoColumns = useCallback((cols: number) => {
    setPhotoColumns(cols);
    photoColumnsRef.current = cols;
    AsyncStorage.setItem(PHOTO_COLUMNS_STORAGE_KEY, String(cols)).catch(() => undefined);
  }, []);

  /** 双指捏合：放大 -> 列数变少（格子变大）；缩小 -> 列数变多（格子变小） */
  const photoPinch = useMemo(
    () =>
      Gesture.Pinch()
        .runOnJS(true)
        .onStart(() => {
          pinchBaseRef.current = photoColumnsRef.current;
        })
        .onUpdate((event) => {
          const raw = Math.round(pinchBaseRef.current / event.scale);
          const clamped = Math.max(PHOTO_COLUMN_MIN, Math.min(PHOTO_COLUMN_MAX, raw));
          const nearest = PHOTO_COLUMN_OPTIONS.reduce((best, opt) =>
            Math.abs(opt - clamped) < Math.abs(best - clamped) ? opt : best
          );
          if (nearest !== photoColumnsRef.current) {
            setPhotoColumns(nearest);
            photoColumnsRef.current = nearest;
          }
        })
        .onEnd(() => {
          AsyncStorage.setItem(PHOTO_COLUMNS_STORAGE_KEY, String(photoColumnsRef.current)).catch(
            () => undefined
          );
        }),
    []
  );

  const filteredPhotos = useMemo(() => {
    if (!photoSearch.trim()) return photos;
    const token = photoSearch.trim().toLowerCase();
    return photos.filter((photo) => photo.filename.toLowerCase().includes(token));
  }, [photos, photoSearch]);

  const handleRetryPermission = useCallback(async () => {
    if (!permissionCanAskAgain) {
      await Linking.openSettings();
      return;
    }

    const granted = await requestPermission();
    if (granted) {
      await loadVideos();
    }
  }, [loadVideos, permissionCanAskAgain, requestPermission]);

  const openRenameDialog = useCallback((video: VideoItem) => {
    setRenameTarget(video);
    setRenameText(video.filename);
    setRenameError(null);
  }, []);

  const closeRenameDialog = useCallback(() => {
    setRenameTarget(null);
    setRenameError(null);
  }, []);

  const handleSearchSubmit = useCallback(() => {
    setSearchQuery(searchDraft.trim());
    Keyboard.dismiss();
  }, [searchDraft]);

  const handleSearchClear = useCallback(() => {
    setSearchDraft('');
    setSearchQuery('');
    Keyboard.dismiss();
  }, []);

  const requestAllFilesAccess = useCallback(async () => {
    const applicationId = Application.applicationId;
    if (!applicationId) return;
    pendingAllFilesRecheck.current = true;
    try {
      await IntentLauncher.startActivityAsync(
        IntentLauncher.ActivityAction.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
        { data: `package:${applicationId}` }
      );
    } catch {
      try {
        await IntentLauncher.startActivityAsync(
          IntentLauncher.ActivityAction.MANAGE_ALL_FILES_ACCESS_PERMISSION
        );
      } catch (error) {
        console.warn('Unable to open all-files-access settings:', error);
        pendingAllFilesRecheck.current = false;
        Linking.openSettings().catch((error) => {
          console.warn('Unable to open app settings:', error);
        });
      }
    }
  }, []);

  const confirmRename = useCallback(async () => {
    if (!renameTarget || renaming) return;

    const trimmed = renameText.trim();
    if (!trimmed) {
      setRenameError('文件名不能为空');
      return;
    }

    const lastDotIndex = trimmed.lastIndexOf('.');
    const extension = renameTarget.filename.slice(
      renameTarget.filename.lastIndexOf('.')
    );
    const finalName =
      lastDotIndex > 0 ? trimmed : `${trimmed}${extension}`;

    if (finalName === renameTarget.filename) {
      closeRenameDialog();
      return;
    }

    setRenaming(true);
    setRenameError(null);

    const dirUri = renameTarget.uri.slice(0, renameTarget.uri.lastIndexOf('/'));
    const targetUri = `${dirUri}/${finalName}`;
    try {
      const renamed = renameVideoFile(renameTarget.uri, targetUri);
      if (!renamed) {
        setRenameError(
          '重命名失败，请确认已授予「所有文件访问」权限后重试'
        );
        return;
      }
      setVideos((prev) =>
        prev.map((video) =>
          video.id === renameTarget.id
            ? { ...video, filename: finalName, uri: targetUri }
            : video
        )
      );
      closeRenameDialog();
    } catch (error) {
      console.warn('Rename failed:', error);
      setRenameError('重命名失败，需要「所有文件访问」权限，请授权后重试');
    } finally {
      setRenaming(false);
    }
  }, [closeRenameDialog, renameTarget, renameText, renaming]);

  const renderVideoCard = useCallback(
    ({ item }: { item: VideoItem }) => {
      const qualityLabel =
        item.width > 0 && item.height > 0
          ? getQualityLabel(item.width, item.height)
          : null;

      if (viewMode === 'list') {
        return (
          <TouchableOpacity
            style={styles.listItem}
            activeOpacity={0.7}
            onPress={() => handlePlayVideo(item)}
            onLongPress={() => openRenameDialog(item)}
          >
            <View style={styles.listThumbnail}>
              <FontAwesome6 name="film" size={24} color={c.accent} />
              <VideoThumbnail uri={item.uri} />
              {item.duration > 0 && (
                <View style={styles.listDurationBadge}>
                  <Text style={styles.listDurationText}>
                    {formatDuration(item.duration * 1000)}
                  </Text>
                </View>
              )}
            </View>
            <View style={styles.listInfo}>
              <Text style={styles.listTitle} numberOfLines={2}>
                {renderHighlightedFilename(item.filename, searchTokens, c.accent)}
              </Text>
              <View style={styles.listMeta}>
                {qualityLabel && (
                  <View style={styles.qualityBadge}>
                    <Text style={styles.qualityText}>{qualityLabel}</Text>
                  </View>
                )}
                {item.duration > 0 && (
                  <Text style={styles.metaText}>
                    {formatDuration(item.duration * 1000)}
                  </Text>
                )}
                {item.fileSize > 0 && (
                  <Text style={styles.metaText}>
                    {formatFileSize(item.fileSize)}
                  </Text>
                )}
              </View>
            </View>
            <TouchableOpacity
              style={styles.listEditButton}
              onPress={() => openRenameDialog(item)}
            >
              <FontAwesome6 name="pen" size={13} color={c.muted} />
            </TouchableOpacity>
            <FontAwesome6 name="chevron-right" size={14} color={c.muted} />
          </TouchableOpacity>
        );
      }

      return (
        <TouchableOpacity
          style={styles.gridCard}
          activeOpacity={0.7}
          onPress={() => handlePlayVideo(item)}
          onLongPress={() => openRenameDialog(item)}
        >
          <View style={styles.gridThumbnail}>
            <FontAwesome6 name="film" size={32} color={c.accent} />
            <VideoThumbnail uri={item.uri} />
            {item.duration > 0 && (
              <View style={styles.gridDurationBadge}>
                <Text style={styles.gridDurationText}>
                  {formatDuration(item.duration * 1000)}
                </Text>
              </View>
            )}
            {qualityLabel && (
              <View style={styles.gridQualityBadge}>
                <Text style={styles.gridQualityText}>{qualityLabel}</Text>
              </View>
            )}
            <TouchableOpacity
              style={styles.gridEditButton}
              onPress={() => openRenameDialog(item)}
            >
              <FontAwesome6 name="pen" size={11} color="#FFFFFF" />
            </TouchableOpacity>
          </View>
          <View style={styles.gridInfo}>
            <Text style={styles.gridTitle} numberOfLines={2}>
              {renderHighlightedFilename(item.filename, searchTokens, c.accent)}
            </Text>
            <Text style={styles.gridMeta} numberOfLines={1}>
              {item.width > 0 && item.height > 0
                ? `${item.width}x${item.height}`
                : 'Video'}
              {item.fileSize > 0 ? ` · ${formatFileSize(item.fileSize)}` : ''}
            </Text>
          </View>
        </TouchableOpacity>
      );
    },
    [handlePlayVideo, openRenameDialog, viewMode, searchTokens]
  );

  const photoCardWidth = (screenWidth - GRID_GAP * 2) / photoColumns - GRID_GAP;

  const renderPhotoCard = useCallback(
    ({ item }: { item: PhotoItem }) => (
      <TouchableOpacity
        style={[styles.photoCard, { width: photoCardWidth }]}
        activeOpacity={0.7}
        onPress={() => handleOpenPhoto(item)}
      >
        <Image
          source={{ uri: item.uri }}
          style={styles.photoImage}
          resizeMode="cover"
        />
      </TouchableOpacity>
    ),
    [handleOpenPhoto, photoCardWidth]
  );

  const renderGroupedRow = useCallback(
    ({ item }: { item: VideoItem[] }) => {
      if (item.length === 1) {
        return renderVideoCard({ item: item[0] });
      }
      return (
        <View style={styles.gridRow}>
          {item.map((video) => (
            <View key={video.id}>{renderVideoCard({ item: video })}</View>
          ))}
        </View>
      );
    },
    [renderVideoCard]
  );

  if (loading) {
    return (
      <Screen backgroundColor={c.background} statusBarStyle={statusBarStyle}>
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={c.accent} />
          <Text style={styles.loadingText}>正在扫描视频文件...</Text>
        </View>
      </Screen>
    );
  }

  if (!permissionGranted) {
    return (
      <Screen backgroundColor={c.background} statusBarStyle={statusBarStyle}>
        <View style={styles.centerContainer}>
          <View style={styles.permissionIcon}>
            <FontAwesome6 name="video" size={48} color={c.accent} />
          </View>
          <Text style={styles.permissionTitle}>需要媒体访问权限</Text>
          <Text style={styles.permissionDesc}>
            请授予媒体库访问权限，以便扫描和播放您设备上的视频文件
          </Text>
          <TouchableOpacity style={styles.permissionButton} onPress={handleRetryPermission}>
            <Text style={styles.permissionButtonText}>
              {permissionCanAskAgain ? '授予权限' : '打开系统设置'}
            </Text>
          </TouchableOpacity>
        </View>
      </Screen>
    );
  }

  return (
    <Screen backgroundColor={c.background} statusBarStyle={statusBarStyle} safeAreaEdges={['left', 'right']}>
      <View style={[styles.header, { paddingTop: Platform.OS === 'web' ? 20 : insets.top + 12 }]}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>视频播放器</Text>
          <Text style={styles.headerSubtitle}>
            {activeTab === 'video'
              ? isSearching
                ? `匹配 ${filteredVideos.length} / ${videos.length} 个视频`
                : `共 ${videos.length} 个视频`
              : photoSearch.trim()
                ? `匹配 ${filteredPhotos.length} / ${photos.length} 张图片`
                : `共 ${photos.length} 张图片`}
          </Text>
        </View>
        <View style={styles.headerActions}>
          {activeTab === 'video' && (
            <>
              <TouchableOpacity
                style={styles.viewToggle}
                onPress={() => router.push('/bili-import')}
              >
                <FontAwesome6 name="clapperboard" size={15} color={c.muted} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.viewToggle}
                onPress={handleCycleTheme}
              >
                <FontAwesome6
                  name={
                    preference === 'system'
                      ? 'circle-half-stroke'
                      : preference === 'light'
                        ? 'sun'
                        : 'moon'
                  }
                  size={15}
                  color={muted}
                />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.viewToggle, grouped && styles.viewToggleActive]}
                onPress={() => setGrouped((prev) => !prev)}
              >
                <FontAwesome6
                  name="layer-group"
                  size={17}
                  color={grouped ? c.accentForeground : c.muted}
                />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.viewToggle}
                onPress={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
              >
                <FontAwesome6
                  name={viewMode === 'grid' ? 'list' : 'table-cells-large'}
                  size={18}
                  color={c.muted}
                />
              </TouchableOpacity>
            </>
          )}
          {activeTab === 'photo' && (
            <TouchableOpacity
              style={styles.viewToggle}
              onPress={handleCycleTheme}
            >
              <FontAwesome6
                name={
                  preference === 'system'
                    ? 'circle-half-stroke'
                    : preference === 'light'
                      ? 'sun'
                      : 'moon'
                }
                size={15}
                color={muted}
              />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <View style={styles.homeTabs}>
        {(
          [
            { key: 'video', label: '视频', icon: 'film' },
            { key: 'photo', label: '图片', icon: 'image' },
          ] as const
        ).map((tab) => {
          const active = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[styles.homeTab, active && styles.homeTabActive]}
              onPress={() => setActiveTab(tab.key)}
            >
              <FontAwesome6
                name={tab.icon}
                size={14}
                color={active ? c.accentForeground : c.muted}
              />
              <Text style={[styles.homeTabText, active && styles.homeTabTextActive]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {activeTab === 'photo' ? (
        <View>
          <View style={styles.searchBar}>
            <FontAwesome6 name="magnifying-glass" size={14} color={c.muted} />
            <TextInput
              style={styles.searchInput}
              value={photoSearch}
              onChangeText={setPhotoSearch}
              placeholder="搜索图片文件名"
              placeholderTextColor={c.muted}
              autoCorrect={false}
              autoCapitalize="none"
            />
            {photoSearch.length > 0 && (
              <TouchableOpacity
                style={styles.searchClearButton}
                onPress={() => setPhotoSearch('')}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <FontAwesome6 name="xmark" size={13} color={c.muted} />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.gridToggle}
              onPress={() => setGridPickerOpen((prev) => !prev)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel="切换网格大小"
            >
              <FontAwesome6
                name="table-cells"
                size={15}
                color={gridPickerOpen ? c.accent : c.muted}
              />
            </TouchableOpacity>
          </View>
          {gridPickerOpen && (
            <View style={styles.gridPicker}>
              {PHOTO_COLUMN_OPTIONS.map((cols) => {
                const selected = cols === photoColumns;
                return (
                  <TouchableOpacity
                    key={cols}
                    style={[styles.gridPickerItem, selected && styles.gridPickerItemActive]}
                    onPress={() => applyPhotoColumns(cols)}
                    accessibilityLabel={`${cols} 列网格`}
                  >
                    <Text
                      style={[styles.gridPickerText, selected && styles.gridPickerTextActive]}
                    >
                      {cols}
                    </Text>
                  </TouchableOpacity>
                );
              })}
              <View style={styles.gridPickerHint}>
                <FontAwesome6 name="hand" size={10} color={c.muted} />
                <Text style={styles.gridPickerHintText}>双指捏合缩放网格</Text>
              </View>
            </View>
          )}
        </View>
      ) : (
        <>
          {grouped && (
            <View style={styles.groupTabs}>
              {(
                [
                  { key: 'folder', label: '按来源' },
                  { key: 'date', label: '按时间' },
                ] as const
              ).map((option) => {
                const active = groupBy === option.key;
                return (
                  <TouchableOpacity
                    key={option.key}
                    style={[styles.groupTab, active && styles.groupTabActive]}
                    onPress={() => setGroupBy(option.key)}
                  >
                    <Text
                      style={[styles.groupTabText, active && styles.groupTabTextActive]}
                    >
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          <View style={styles.searchBar}>
            <FontAwesome6 name="magnifying-glass" size={14} color={c.muted} />
            <TextInput
              style={styles.searchInput}
              value={searchDraft}
              onChangeText={setSearchDraft}
              placeholder="搜索文件名或所在文件夹，空格分隔多个关键词"
              placeholderTextColor={c.muted}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
              onSubmitEditing={handleSearchSubmit}
            />
            {isSearching ? (
              <TouchableOpacity
                style={styles.searchClearButton}
                onPress={handleSearchClear}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <FontAwesome6 name="xmark" size={13} color={c.muted} />
              </TouchableOpacity>
            ) : searchDraft.trim().length > 0 ? (
              <TouchableOpacity
                style={styles.searchConfirmButton}
                onPress={handleSearchSubmit}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <FontAwesome6 name="arrow-right" size={13} color={c.accent} />
              </TouchableOpacity>
            ) : null}
          </View>

          {isSearching && filteredVideos.length > 0 && (
            <View style={styles.searchSummary}>
              <FontAwesome6 name="magnifying-glass" size={11} color={c.muted} />
              <Text style={styles.searchSummaryText}>
                找到 {filteredVideos.length} 个相关视频
              </Text>
            </View>
          )}
        </>
      )}

      {!allFilesAccessGranted && (
        <TouchableOpacity
          style={styles.accessBanner}
          onPress={requestAllFilesAccess}
          activeOpacity={0.8}
        >
          <FontAwesome6 name="folder-tree" size={13} color={c.danger} />
          <Text style={styles.accessBannerText} numberOfLines={2}>
            {activeTab === 'photo'
              ? '当前仅显示媒体库图片，开启「所有文件访问」可扫描抖音、浏览器等全部图片'
              : '当前仅扫描媒体库视频，开启「所有文件访问」可扫描抖音、浏览器等全部文件夹'}
          </Text>
          <FontAwesome6 name="chevron-right" size={12} color={c.muted} />
        </TouchableOpacity>
      )}

      {activeTab === 'photo' ? (
        photosLoading ? (
          <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color={c.accent} />
            <Text style={styles.loadingText}>
              {scanCount > 0 ? `正在扫描图片... 已发现 ${scanCount} 张` : '正在扫描图片...'}
            </Text>
          </View>
        ) : filteredPhotos.length === 0 ? (
          <View style={styles.emptyContainer}>
            <FontAwesome6 name="image" size={56} color={c.muted} />
            <Text style={styles.emptyTitle}>
              {photos.length === 0 ? '未发现图片文件' : '未找到匹配的图片'}
            </Text>
            <Text style={styles.emptyDesc}>
              {photos.length === 0
                ? '设备媒体库中没有找到图片'
                : '换个关键词试试'}
            </Text>
          </View>
        ) : (
          <GestureDetector gesture={photoPinch}>
            <FlatList
              key={`photo-grid-${photoColumns}`}
              data={filteredPhotos}
              keyExtractor={(item) => item.id}
              renderItem={renderPhotoCard}
              numColumns={photoColumns}
              contentContainerStyle={styles.photoList}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              initialNumToRender={12}
              maxToRenderPerBatch={16}
              windowSize={7}
            />
          </GestureDetector>
        )
      ) : videos.length === 0 ? (
        <View style={styles.emptyContainer}>
          <FontAwesome6 name="folder-open" size={56} color={c.muted} />
          <Text style={styles.emptyTitle}>未发现视频文件</Text>
          <Text style={styles.emptyDesc}>
            设备上没有找到视频文件{'\n'}支持 MP4, MKV, AVI, MOV, WebM 等格式
          </Text>
        </View>
      ) : filteredVideos.length === 0 ? (
        <View style={styles.emptyContainer}>
          <FontAwesome6 name="magnifying-glass" size={48} color={c.muted} />
          <Text style={styles.emptyTitle}>未找到匹配的视频</Text>
          <Text style={styles.emptyDesc}>换个关键词试试</Text>
        </View>
      ) : grouped && !isSearching ? (
        <SectionList<VideoItem[], VideoSection>
          sections={groupedSections}
          keyExtractor={(item) => item[0].id}
          renderItem={renderGroupedRow}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <FontAwesome6 name="folder" size={12} color={c.accent} />
              <Text style={styles.sectionTitle}>{section.title}</Text>
              <Text style={styles.sectionCount}>
                {section.data.reduce((sum, row) => sum + row.length, 0)}
              </Text>
            </View>
          )}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={
            viewMode === 'grid' ? styles.gridList : styles.listList
          }
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={() => <View style={styles.listSeparator} />}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <FontAwesome6 name="magnifying-glass" size={48} color={c.muted} />
              <Text style={styles.emptyTitle}>未找到匹配的视频</Text>
              <Text style={styles.emptyDesc}>换个关键词试试</Text>
            </View>
          }
        />
      ) : (
        <FlatList
          key={viewMode}
          data={filteredVideos}
          keyExtractor={(item) => item.id}
          renderItem={renderVideoCard}
          numColumns={viewMode === 'grid' ? 2 : 1}
          contentContainerStyle={
            viewMode === 'grid' ? styles.gridList : styles.listList
          }
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={() =>
            viewMode === 'list' ? <View style={styles.listSeparator} /> : null
          }
        />
      )}

      <Modal
        visible={renameTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={closeRenameDialog}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.renamePanel}>
            <Text style={styles.renameTitle}>重命名视频</Text>
            <TextInput
              style={styles.renameInput}
              value={renameText}
              onChangeText={setRenameText}
              placeholder="输入新的文件名"
              placeholderTextColor={c.muted}
              autoCorrect={false}
              autoCapitalize="none"
              selectTextOnFocus
            />
            {!!renameError && (
              <Text style={styles.renameError}>{renameError}</Text>
            )}
            {renameError && (
              <TouchableOpacity
                style={styles.renamePermissionLink}
                onPress={requestAllFilesAccess}
              >
                <Text style={styles.renamePermissionText}>
                  前往开启「所有文件访问」权限
                </Text>
              </TouchableOpacity>
            )}
            <View style={styles.renameActions}>
              <TouchableOpacity
                style={[styles.renameButton, styles.renameButtonSecondary]}
                onPress={closeRenameDialog}
                disabled={renaming}
              >
                <Text style={styles.renameButtonSecondaryText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.renameButton, styles.renameButtonPrimary]}
                onPress={confirmRename}
                disabled={renaming}
              >
                <Text style={styles.renameButtonPrimaryText}>
                  {renaming ? '保存中...' : '保存'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

function createStyles(c: ThemePalette) {
  return StyleSheet.create({
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  loadingText: {
    color: c.muted,
    fontSize: 14,
    marginTop: 16,
  },
  permissionIcon: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: c.accentSoft,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  permissionTitle: {
    color: c.foreground,
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 8,
  },
  permissionDesc: {
    color: c.muted,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
  },
  permissionButton: {
    backgroundColor: c.accent,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
  },
  permissionButtonText: {
    color: c.accentForeground,
    fontSize: 15,
    fontWeight: '600',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'web' ? 20 : 12,
    paddingBottom: 16,
  },
  headerLeft: {
    flex: 1,
  },
  headerTitle: {
    color: c.foreground,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    color: c.muted,
    fontSize: 13,
    marginTop: 4,
    fontWeight: '500',
  },
  viewToggle: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: c.surface,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: c.border,
  },
  viewToggleActive: {
    backgroundColor: c.accent,
    borderColor: c.accent,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  homeTabs: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  homeTab: {
    flex: 1,
    height: 38,
    borderRadius: 10,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  homeTabActive: {
    backgroundColor: c.accent,
    borderColor: c.accent,
  },
  homeTabText: {
    color: c.muted,
    fontSize: 13,
    fontWeight: '600',
  },
  homeTabTextActive: {
    color: c.accentForeground,
  },
  photoList: {
    paddingHorizontal: GRID_GAP,
    paddingBottom: 40,
  },
  photoCard: {
    aspectRatio: 1,
    marginHorizontal: GRID_GAP / 2,
    marginBottom: GRID_GAP,
    backgroundColor: c.backgroundTertiary,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: c.border,
    position: 'relative',
  },
  photoImage: {
    ...StyleSheet.absoluteFillObject,
  },
  groupTabs: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  groupTab: {
    height: 30,
    paddingHorizontal: 14,
    borderRadius: 15,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    justifyContent: 'center',
  },
  groupTabActive: {
    backgroundColor: c.accent,
    borderColor: c.accent,
  },
  groupTabText: {
    color: c.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  groupTabTextActive: {
    color: c.accentForeground,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
  },
  sectionTitle: {
    flex: 1,
    color: c.foreground,
    fontSize: 14,
    fontWeight: '700',
  },
  sectionCount: {
    color: c.muted,
    fontSize: 12,
    fontWeight: '600',
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    overflow: 'hidden',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emptyTitle: {
    color: c.foreground,
    fontSize: 18,
    fontWeight: '600',
    marginTop: 20,
    marginBottom: 8,
  },
  emptyDesc: {
    color: c.muted,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
  },
  // Grid styles
  gridList: {
    paddingHorizontal: GRID_GAP,
    paddingBottom: 40,
  },
  gridRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  gridCard: {
    width: CARD_WIDTH,
    marginHorizontal: GRID_GAP / 2,
    marginBottom: GRID_GAP,
    backgroundColor: c.surface,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: c.border,
  },
  gridThumbnail: {
    width: '100%',
    aspectRatio: 16 / 10,
    backgroundColor: c.backgroundTertiary,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  gridDurationBadge: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.75)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  gridDurationText: {
    color: c.foreground,
    fontSize: 11,
    fontWeight: '600',
  },
  gridQualityBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: c.accent,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  gridQualityText: {
    color: c.accentForeground,
    fontSize: 10,
    fontWeight: '700',
  },
  gridInfo: {
    padding: 10,
  },
  gridTitle: {
    color: c.foreground,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  gridMeta: {
    color: c.muted,
    fontSize: 11,
    marginTop: 4,
    fontWeight: '500',
  },
  // List styles
  listList: {
    paddingHorizontal: 16,
    paddingBottom: 40,
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: c.border,
  },
  listThumbnail: {
    width: 72,
    height: 52,
    borderRadius: 8,
    backgroundColor: c.backgroundTertiary,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  listDurationBadge: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    backgroundColor: 'rgba(0,0,0,0.75)',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },
  listDurationText: {
    color: c.foreground,
    fontSize: 9,
    fontWeight: '600',
  },
  listInfo: {
    flex: 1,
  },
  listTitle: {
    color: c.foreground,
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
  },
  listMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: 8,
  },
  qualityBadge: {
    backgroundColor: c.accentSoft,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
  },
  qualityText: {
    color: c.accent,
    fontSize: 10,
    fontWeight: '700',
  },
  metaText: {
    color: c.muted,
    fontSize: 12,
    fontWeight: '500',
  },
  listSeparator: {
    height: 8,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 12,
    height: 40,
    paddingHorizontal: 12,
    backgroundColor: c.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.border,
  },
  searchInput: {
    flex: 1,
    color: c.foreground,
    fontSize: 14,
    paddingVertical: 0,
  },
  searchClearButton: {
    width: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  gridToggle: {
    width: 26,
    height: 26,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  gridPicker: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingBottom: 12,
    marginTop: -2,
  },
  gridPickerItem: {
    minWidth: 34,
    height: 30,
    paddingHorizontal: 8,
    borderRadius: 15,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridPickerItemActive: {
    backgroundColor: c.accent,
    borderColor: c.accent,
  },
  gridPickerText: {
    color: c.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  gridPickerTextActive: {
    color: c.accentForeground,
  },
  gridPickerHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 'auto',
  },
  gridPickerHintText: {
    color: c.muted,
    fontSize: 10,
  },
  searchConfirmButton: {
    width: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  searchSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  searchSummaryText: {
    color: c.muted,
    fontSize: 12,
  },
  accessBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: c.dangerSoft,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(252,165,165,0.2)',
  },
  accessBannerText: {
    flex: 1,
    color: c.danger,
    fontSize: 12,
    lineHeight: 17,
  },
  gridEditButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  listEditButton: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 4,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: 32,
  },
  renamePanel: {
    backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.border,
    padding: 18,
  },
  renameTitle: {
    color: c.foreground,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  renameInput: {
    backgroundColor: c.background,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.border,
    color: c.foreground,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  renameError: {
    color: c.danger,
    fontSize: 12,
    marginTop: 8,
  },
  renamePermissionLink: {
    marginTop: 8,
  },
  renamePermissionText: {
    color: c.accent,
    fontSize: 12,
    textDecorationLine: 'underline',
  },
  renameActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 16,
  },
  renameButton: {
    height: 38,
    paddingHorizontal: 16,
    borderRadius: 10,
    justifyContent: 'center',
  },
  renameButtonPrimary: {
    backgroundColor: c.accent,
  },
  renameButtonPrimaryText: {
    color: c.accentForeground,
    fontSize: 14,
    fontWeight: '600',
  },
  renameButtonSecondary: {
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  renameButtonSecondaryText: {
    color: c.foreground,
    fontSize: 14,
  },
});
}
