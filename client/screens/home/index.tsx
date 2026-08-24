import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Dimensions,
  Platform,
  StyleSheet,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useFocusEffect } from 'expo-router';
import { formatFileSize, formatDuration, getQualityLabel } from '@/utils/format';

const { width: screenWidth } = Dimensions.get('window');
const GRID_GAP = 12;
const CARD_WIDTH = (screenWidth - GRID_GAP * 3) / 2;

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

export default function HomeScreen() {
  const router = useSafeRouter();
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  const requestPermission = useCallback(async () => {
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status === 'granted') {
        setPermissionGranted(true);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  const loadVideos = useCallback(async () => {
    try {
      setLoading(true);
      const assets = await MediaLibrary.getAssetsAsync({
        mediaType: 'video',
        sortBy: ['modificationTime'],
        first: 100,
      });

      const videoItems: VideoItem[] = assets.assets.map((asset) => ({
        id: asset.id,
        uri: asset.uri,
        filename: asset.filename || 'Unknown',
        duration: asset.duration || 0,
        width: asset.width || 0,
        height: asset.height || 0,
        fileSize: 0,
        modificationTime: asset.modificationTime || 0,
        mimeType: '',
      }));

      setVideos(videoItems);
    } catch (error) {
      console.error('Failed to load videos:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      const granted = await requestPermission();
      if (granted) {
        await loadVideos();
      } else {
        setLoading(false);
      }
    };
    init();
  }, [requestPermission, loadVideos]);

  useFocusEffect(
    useCallback(() => {
      if (permissionGranted) {
        loadVideos();
      }
    }, [permissionGranted, loadVideos])
  );

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

  const handleRetryPermission = useCallback(async () => {
    const granted = await requestPermission();
    if (granted) {
      await loadVideos();
    }
  }, [requestPermission, loadVideos]);

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
          >
            <View style={styles.listThumbnail}>
              <FontAwesome6 name="film" size={24} color="#6366F1" />
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
                {item.filename}
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
            <FontAwesome6 name="chevron-right" size={14} color="#64748B" />
          </TouchableOpacity>
        );
      }

      return (
        <TouchableOpacity
          style={styles.gridCard}
          activeOpacity={0.7}
          onPress={() => handlePlayVideo(item)}
        >
          <View style={styles.gridThumbnail}>
            <FontAwesome6 name="film" size={32} color="#6366F1" />
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
          </View>
          <View style={styles.gridInfo}>
            <Text style={styles.gridTitle} numberOfLines={2}>
              {item.filename}
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
    [handlePlayVideo, viewMode]
  );

  if (loading) {
    return (
      <Screen backgroundColor="#0A0A0F" statusBarStyle="light">
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color="#6366F1" />
          <Text style={styles.loadingText}>正在扫描视频文件...</Text>
        </View>
      </Screen>
    );
  }

  if (!permissionGranted) {
    return (
      <Screen backgroundColor="#0A0A0F" statusBarStyle="light">
        <View style={styles.centerContainer}>
          <View style={styles.permissionIcon}>
            <FontAwesome6 name="video" size={48} color="#6366F1" />
          </View>
          <Text style={styles.permissionTitle}>需要媒体访问权限</Text>
          <Text style={styles.permissionDesc}>
            请授予媒体库访问权限，以便扫描和播放您设备上的视频文件
          </Text>
          <TouchableOpacity style={styles.permissionButton} onPress={handleRetryPermission}>
            <Text style={styles.permissionButtonText}>授予权限</Text>
          </TouchableOpacity>
        </View>
      </Screen>
    );
  }

  return (
    <Screen backgroundColor="#0A0A0F" statusBarStyle="light" safeAreaEdges={['left', 'right']}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>视频播放器</Text>
          <Text style={styles.headerSubtitle}>
            共 {videos.length} 个视频
          </Text>
        </View>
        <TouchableOpacity
          style={styles.viewToggle}
          onPress={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
        >
          <FontAwesome6
            name={viewMode === 'grid' ? 'list' : 'grid'}
            size={18}
            color="#94A3B8"
          />
        </TouchableOpacity>
      </View>

      {videos.length === 0 ? (
        <View style={styles.emptyContainer}>
          <FontAwesome6 name="folder-open" size={56} color="#334155" />
          <Text style={styles.emptyTitle}>未发现视频文件</Text>
          <Text style={styles.emptyDesc}>
            设备上没有找到视频文件{'\n'}支持 MP4, MKV, AVI, MOV, WebM 等格式
          </Text>
        </View>
      ) : (
        <FlatList
          key={viewMode}
          data={videos}
          keyExtractor={(item) => item.id}
          renderItem={renderVideoCard}
          numColumns={viewMode === 'grid' ? 2 : 1}
          contentContainerStyle={
            viewMode === 'grid' ? styles.gridList : styles.listList
          }
          showsVerticalScrollIndicator={false}
          ItemSeparatorComponent={() =>
            viewMode === 'list' ? <View style={styles.listSeparator} /> : null
          }
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  loadingText: {
    color: '#94A3B8',
    fontSize: 14,
    marginTop: 16,
  },
  permissionIcon: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: 'rgba(99, 102, 241, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  permissionTitle: {
    color: '#F1F5F9',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 8,
  },
  permissionDesc: {
    color: '#64748B',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
  },
  permissionButton: {
    backgroundColor: '#6366F1',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
  },
  permissionButtonText: {
    color: '#FFFFFF',
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
    color: '#F1F5F9',
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    color: '#64748B',
    fontSize: 13,
    marginTop: 4,
    fontWeight: '500',
  },
  viewToggle: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#16161E',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emptyTitle: {
    color: '#F1F5F9',
    fontSize: 18,
    fontWeight: '600',
    marginTop: 20,
    marginBottom: 8,
  },
  emptyDesc: {
    color: '#64748B',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
  },
  // Grid styles
  gridList: {
    paddingHorizontal: GRID_GAP,
    paddingBottom: 40,
  },
  gridCard: {
    width: CARD_WIDTH,
    marginHorizontal: GRID_GAP / 2,
    marginBottom: GRID_GAP,
    backgroundColor: '#16161E',
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  gridThumbnail: {
    width: '100%',
    aspectRatio: 16 / 10,
    backgroundColor: '#1E1E2A',
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
    color: '#F1F5F9',
    fontSize: 11,
    fontWeight: '600',
  },
  gridQualityBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: '#6366F1',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  gridQualityText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
  },
  gridInfo: {
    padding: 10,
  },
  gridTitle: {
    color: '#F1F5F9',
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  gridMeta: {
    color: '#64748B',
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
    backgroundColor: '#16161E',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  listThumbnail: {
    width: 72,
    height: 52,
    borderRadius: 8,
    backgroundColor: '#1E1E2A',
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
    color: '#F1F5F9',
    fontSize: 9,
    fontWeight: '600',
  },
  listInfo: {
    flex: 1,
  },
  listTitle: {
    color: '#F1F5F9',
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
    backgroundColor: 'rgba(99, 102, 241, 0.15)',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
  },
  qualityText: {
    color: '#818CF8',
    fontSize: 10,
    fontWeight: '700',
  },
  metaText: {
    color: '#64748B',
    fontSize: 12,
    fontWeight: '500',
  },
  listSeparator: {
    height: 8,
  },
});
