/**
 * 首页媒体数据层 Hook
 *
 * 从 home/index.tsx 拆出：媒体库权限、视频/图片加载（500 分页 + 全盘扫描合并去重）、
 * 「所有文件访问」引导与回查、视频重命名。与视图无关，可独立单测。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Application from 'expo-application';
import { useFocusEffect } from 'expo-router';
import {
  hasAllFilesAccess,
  renameVideoFile,
  scanDeviceForVideos,
  scanDeviceForPhotos,
} from '@/utils/videoScanner';
import { VideoItem, PhotoItem, toMilliseconds, normalizePath } from '../screens/home/shared';

export function useHomeMedia() {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [permissionCanAskAgain, setPermissionCanAskAgain] = useState(true);
  const [hasInitialized, setHasInitialized] = useState(false);
  const [allFilesAccessGranted, setAllFilesAccessGranted] = useState(true);
  const pendingAllFilesRecheck = useRef(false);
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [scanCount, setScanCount] = useState(0);
  const [renameTarget, setRenameTarget] = useState<VideoItem | null>(null);
  const [renameText, setRenameText] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

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

  return {
    videos,
    setVideos,
    loading,
    permissionGranted,
    permissionCanAskAgain,
    hasInitialized,
    allFilesAccessGranted,
    photos,
    photosLoading,
    scanCount,
    renameTarget,
    renameText,
    setRenameText,
    renameError,
    renaming,
    loadVideos,
    handleRetryPermission,
    openRenameDialog,
    closeRenameDialog,
    requestAllFilesAccess,
    confirmRename,
  };
}

export type HomeMedia = ReturnType<typeof useHomeMedia>;
