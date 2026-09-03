/**
 * 视频卡片（grid / list 两种形态）
 *
 * 从 home/index.tsx 的 renderVideoCard 拆出，纯展示组件，行为与原实现一致。
 */
import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { VideoThumbnail } from '@/components/VideoThumbnail';
import { formatFileSize, formatDuration, getQualityLabel } from '@/utils/format';
import { renderHighlightedFilename, ThemePalette, VideoItem } from './shared';
import { createStyles } from './styles';

type Styles = ReturnType<typeof createStyles>;

interface VideoCardProps {
  video: VideoItem;
  viewMode: 'grid' | 'list';
  searchTokens: string[];
  onPlay: (video: VideoItem) => void;
  onRename: (video: VideoItem) => void;
  styles: Styles;
  c: ThemePalette;
}

export function VideoCard({
  video,
  viewMode,
  searchTokens,
  onPlay,
  onRename,
  styles,
  c,
}: VideoCardProps) {
  const qualityLabel =
    video.width > 0 && video.height > 0
      ? getQualityLabel(video.width, video.height)
      : null;

  if (viewMode === 'list') {
    return (
      <TouchableOpacity
        style={styles.listItem}
        activeOpacity={0.7}
        onPress={() => onPlay(video)}
        onLongPress={() => onRename(video)}
      >
        <View style={styles.listThumbnail}>
          <FontAwesome6 name="film" size={24} color={c.accent} />
          <VideoThumbnail uri={video.uri} />
          {video.duration > 0 && (
            <View style={styles.listDurationBadge}>
              <Text style={styles.listDurationText}>
                {formatDuration(video.duration * 1000)}
              </Text>
            </View>
          )}
        </View>
        <View style={styles.listInfo}>
          <Text style={styles.listTitle} numberOfLines={2}>
            {renderHighlightedFilename(video.filename, searchTokens, c.accent)}
          </Text>
          <View style={styles.listMeta}>
            {qualityLabel && (
              <View style={styles.qualityBadge}>
                <Text style={styles.qualityText}>{qualityLabel}</Text>
              </View>
            )}
            {video.duration > 0 && (
              <Text style={styles.metaText}>
                {formatDuration(video.duration * 1000)}
              </Text>
            )}
            {video.fileSize > 0 && (
              <Text style={styles.metaText}>
                {formatFileSize(video.fileSize)}
              </Text>
            )}
          </View>
        </View>
        <TouchableOpacity
          style={styles.listEditButton}
          onPress={() => onRename(video)}
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
      onPress={() => onPlay(video)}
      onLongPress={() => onRename(video)}
    >
      <View style={styles.gridThumbnail}>
        <FontAwesome6 name="film" size={32} color={c.accent} />
        <VideoThumbnail uri={video.uri} />
        {video.duration > 0 && (
          <View style={styles.gridDurationBadge}>
            <Text style={styles.gridDurationText}>
              {formatDuration(video.duration * 1000)}
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
          onPress={() => onRename(video)}
        >
          <FontAwesome6 name="pen" size={11} color="#FFFFFF" />
        </TouchableOpacity>
      </View>
      <View style={styles.gridInfo}>
        <Text style={styles.gridTitle} numberOfLines={2}>
          {renderHighlightedFilename(video.filename, searchTokens, c.accent)}
        </Text>
        <Text style={styles.gridMeta} numberOfLines={1}>
          {video.width > 0 && video.height > 0
            ? `${video.width}x${video.height}`
            : 'Video'}
          {video.fileSize > 0 ? ` · ${formatFileSize(video.fileSize)}` : ''}
        </Text>
      </View>
    </TouchableOpacity>
  );
}
