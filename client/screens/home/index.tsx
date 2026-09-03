import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  SectionList,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  TextInput,
  Keyboard,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useHomeMedia } from '@/hooks/useHomeMedia';
import { usePhotoGridColumns } from '@/hooks/usePhotoGridColumns';
import { GlowBackground } from '@/components/glass';
import { useCSSVariable } from 'uniwind';
import { useThemePreference } from '@/contexts/ThemeContext';

import {
  GRID_COLUMNS,
  PHOTO_COLUMN_OPTIONS,
  VideoItem,
  PhotoItem,
  HomeTab,
  toMilliseconds,
  getSearchHaystack,
  VideoGroup,
  VideoSection,
  chunkArray,
  resolveSourceLabel,
  resolveDateBucket,
  DATE_BUCKET_ORDER,
  ThemePalette,
} from './shared';
import { createStyles } from './styles';
import { VideoCard } from './VideoCard';
import { PhotoGrid } from './PhotoGrid';
import { RenameDialog } from './RenameDialog';

export default function HomeScreen() {
  const router = useSafeRouter();
  const insets = useSafeAreaInsets();
  const { preference } = useThemePreference();
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

  // 数据层：权限、视频/图片加载与分页、全盘扫描合并、重命名（原 index 内联逻辑）
  const {
    videos,
    loading,
    permissionGranted,
    permissionCanAskAgain,
    allFilesAccessGranted,
    photos,
    photosLoading,
    scanCount,
    renameTarget,
    renameText,
    setRenameText,
    renameError,
    renaming,
    handleRetryPermission,
    openRenameDialog,
    closeRenameDialog,
    requestAllFilesAccess,
    confirmRename,
  } = useHomeMedia();

  // 图片网格列数：捏合手势 + 持久化（搜索栏网格选择器共享）
  const { photoColumns, applyPhotoColumns, photoPinch } = usePhotoGridColumns();

  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [grouped, setGrouped] = useState(false);
  const [groupBy, setGroupBy] = useState<'folder' | 'date'>('folder');
  const [searchDraft, setSearchDraft] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<HomeTab>('video');
  const [photoSearch, setPhotoSearch] = useState('');
  const [gridPickerOpen, setGridPickerOpen] = useState(false);

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

  const filteredPhotos = useMemo(() => {
    if (!photoSearch.trim()) return photos;
    const token = photoSearch.trim().toLowerCase();
    return photos.filter((photo) => photo.filename.toLowerCase().includes(token));
  }, [photos, photoSearch]);

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

  const handleSearchSubmit = useCallback(() => {
    setSearchQuery(searchDraft.trim());
    Keyboard.dismiss();
  }, [searchDraft]);

  const handleSearchClear = useCallback(() => {
    setSearchDraft('');
    setSearchQuery('');
    Keyboard.dismiss();
  }, []);

  const renderVideoItem = useCallback(
    ({ item }: { item: VideoItem }) => (
      <VideoCard
        video={item}
        viewMode={viewMode}
        searchTokens={searchTokens}
        onPlay={handlePlayVideo}
        onRename={openRenameDialog}
        styles={styles}
        c={c}
      />
    ),
    [handlePlayVideo, openRenameDialog, viewMode, searchTokens, styles, c]
  );

  const renderGroupedRow = useCallback(
    ({ item }: { item: VideoItem[] }) => {
      if (item.length === 1) {
        return (
          <VideoCard
            video={item[0]}
            viewMode={viewMode}
            searchTokens={searchTokens}
            onPlay={handlePlayVideo}
            onRename={openRenameDialog}
            styles={styles}
            c={c}
          />
        );
      }
      return (
        <View style={styles.gridRow}>
          {item.map((video) => (
            <View key={video.id}>
              <VideoCard
                video={video}
                viewMode={viewMode}
                searchTokens={searchTokens}
                onPlay={handlePlayVideo}
                onRename={openRenameDialog}
                styles={styles}
                c={c}
              />
            </View>
          ))}
        </View>
      );
    },
    [handlePlayVideo, openRenameDialog, viewMode, searchTokens, styles, c]
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
      {/* 液态玻璃光环境：三色柔光光斑缓慢流动 */}
      <GlowBackground colors={[c.accent, '#22D3EE', '#A78BFA']} opacity={0.3} />
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
                onPress={() => router.push('/settings')}
                accessibilityLabel="设置"
              >
                <FontAwesome6 name="gear" size={15} color={muted} />
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
              onPress={() => router.push('/settings')}
              accessibilityLabel="设置"
            >
              <FontAwesome6 name="gear" size={15} color={muted} />
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
          <PhotoGrid
            photos={filteredPhotos}
            photoColumns={photoColumns}
            photoPinch={photoPinch}
            onPressPhoto={handleOpenPhoto}
            styles={styles}
          />
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
          renderItem={renderVideoItem}
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

      <RenameDialog
        visible={renameTarget !== null}
        renameText={renameText}
        onRenameTextChange={setRenameText}
        renameError={renameError}
        renaming={renaming}
        onCancel={closeRenameDialog}
        onConfirm={confirmRename}
        onRequestAllFilesAccess={requestAllFilesAccess}
        styles={styles}
        c={c}
      />
    </Screen>
  );
}
