import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Dimensions,
  Linking,
  Platform,
  SectionList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Application from 'expo-application';
import Toast from 'react-native-toast-message';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { Screen } from '@/components/Screen';
import {
  BILI_STATUS_LABELS,
  convertEpisodes,
  getBiliCacheOverview,
  isBiliConvertSupported,
  type BiliCacheOverview,
  type BiliConvertProgress,
  type BiliConvertResult,
  type BiliEpisode,
  type BiliItemStatus,
} from '@/utils/biliCache';
import { formatFileSize } from '@/utils/format';
import {
  hasAllFilesAccess,
} from '@/utils/videoScanner';
import { useThemePreference } from '@/contexts/ThemeContext';
import { useCSSVariable } from 'uniwind';

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

const STATUS_TONE: Record<BiliItemStatus, 'accent' | 'muted' | 'danger'> = {
  ready: 'accent',
  video_only: 'accent',
  encrypted: 'danger',
  legacy_blv: 'muted',
  incomplete: 'muted',
};

function isImportable(episode: BiliEpisode): boolean {
  return episode.status === 'ready' || episode.status === 'video_only';
}

interface BiliSeasonSection {
  key: string;
  title: string;
  data: BiliEpisode[];
}

export default function BiliImportScreen() {
  const router = useSafeRouter();
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

  const c = useMemo<ThemePalette>(
    () => ({
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
    }),
    [
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
    ]
  );

  const styles = useMemo(() => createStyles(c), [c]);
  const statusBarStyle = preference === 'light' ? 'dark' : 'light';

  const [scanning, setScanning] = useState(true);
  const [overview, setOverview] = useState<BiliCacheOverview | null>(null);
  const [accessGranted, setAccessGranted] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [converting, setConverting] = useState(false);
  const [progress, setProgress] = useState<BiliConvertProgress>({
    doneCount: 0,
    totalCount: 0,
    currentTitle: '',
    itemFraction: 0,
  });
  const pendingRecheck = useRef(false);
  const cancelHandle = useRef({ cancelled: false });

  const importSupported = isBiliConvertSupported();

  const allEpisodes = useMemo(
    () => overview?.seasons.flatMap((season) => season.episodes) ?? [],
    [overview]
  );
  const importableCount = allEpisodes.filter(isImportable).length;
  const selectedEpisodes = useMemo(
    () => allEpisodes.filter((episode) => selectedIds.includes(episode.id)),
    [allEpisodes, selectedIds]
  );

  const runScan = useCallback(async () => {
    setScanning(true);
    try {
      const granted = await hasAllFilesAccess();
      setAccessGranted(granted);
      if (!granted) {
        setOverview({ rootsFound: [], seasons: [] });
        return;
      }
      const result = await getBiliCacheOverview();
      setOverview(result);
      setSelectedIds((prev) =>
        prev.filter((id) =>
          result.seasons.some((season) =>
            season.episodes.some(
              (episode) => episode.id === id && isImportable(episode)
            )
          )
        )
      );
    } catch (error) {
      console.warn('Bili cache scan failed:', error);
      setOverview({ rootsFound: [], seasons: [] });
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    runScan();
  }, [runScan]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !pendingRecheck.current) return;
      pendingRecheck.current = false;
      runScan();
    });
    return () => subscription.remove();
  }, [runScan]);

  const requestAllFilesAccess = useCallback(async () => {
    const applicationId = Application.applicationId;
    if (!applicationId) return;
    pendingRecheck.current = true;
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
        pendingRecheck.current = false;
        Linking.openSettings().catch(() => undefined);
      }
    }
  }, []);

  const toggleSelected = useCallback((episode: BiliEpisode) => {
    if (!isImportable(episode)) return;
    setSelectedIds((prev) =>
      prev.includes(episode.id)
        ? prev.filter((id) => id !== episode.id)
        : [...prev, episode.id]
    );
  }, []);

  const selectAllImportable = useCallback(() => {
    if (!overview) return;
    const ids = overview.seasons
      .flatMap((season) => season.episodes)
      .filter(isImportable)
      .map((episode) => episode.id);
    setSelectedIds((prev) =>
      prev.length === ids.length && ids.every((id) => prev.includes(id))
        ? []
        : ids
    );
  }, [overview]);

  const startConvert = useCallback(async () => {
    if (converting || selectedEpisodes.length === 0) return;
    const queue = [...selectedEpisodes];
    cancelHandle.current = { cancelled: false };
    setConverting(true);
    try {
      const result: BiliConvertResult = await convertEpisodes(queue, {
        handle: cancelHandle.current,
        onProgress: setProgress,
      });
      if (result.cancelled) {
        Toast.show({
          type: 'info',
          text1: `已取消，成功 ${result.succeeded.length} / ${queue.length}`,
        });
      } else if (result.failed.length === 0) {
        Toast.show({
          type: 'success',
          text1: `转换完成`,
          text2: `${result.succeeded.length} 个视频已保存到 Movies/bilibili`,
        });
      } else {
        Toast.show({
          type: 'error',
          text1: `完成 ${result.succeeded.length} 个，失败 ${result.failed.length} 个`,
          text2: result.failed[0]?.reason,
        });
      }
    } finally {
      setConverting(false);
      setProgress({
        doneCount: 0,
        totalCount: 0,
        currentTitle: '',
        itemFraction: 0,
      });
      setSelectedIds([]);
    }
  }, [converting, selectedEpisodes]);

  const overallFraction =
    progress.totalCount > 0
      ? Math.min(
          (progress.doneCount + progress.itemFraction) / progress.totalCount,
          1
        )
      : 0;

  const renderEpisodeRow = useCallback(
    ({ item }: { item: BiliEpisode }) => {
      const selectable = isImportable(item) && !converting && importSupported;
      const selected = selectedIds.includes(item.id);
      const tone = STATUS_TONE[item.status];
      const badgeStyle =
        tone === 'accent'
          ? [styles.statusBadgeAccent]
          : tone === 'danger'
            ? [styles.statusBadgeDanger]
            : [styles.statusBadgeMuted];
      const badgeText =
        tone === 'accent'
          ? styles.statusTextAccent
          : tone === 'danger'
            ? styles.statusTextDanger
            : styles.statusTextMuted;

      return (
        <TouchableOpacity
          style={styles.episodeRow}
          activeOpacity={selectable ? 0.7 : 1}
          disabled={!selectable}
          onPress={() => toggleSelected(item)}
        >
          <View style={styles.checkbox}>
            <FontAwesome6
              name={selected ? 'circle-check' : 'circle'}
              size={20}
              color={
                selected ? c.accent : selectable ? c.muted : c.backgroundTertiary
              }
            />
          </View>
          <View style={styles.episodeInfo}>
            <Text style={styles.episodeTitle} numberOfLines={1}>
              {item.part}
            </Text>
            <View style={styles.episodeMeta}>
              {item.qualityLabel && (
                <View style={styles.qualityBadge}>
                  <Text style={styles.qualityText}>{item.qualityLabel}</Text>
                </View>
              )}
              <View style={[styles.statusBadge, ...badgeStyle]}>
                <Text style={[styles.statusText, badgeText]}>
                  {BILI_STATUS_LABELS[item.status]}
                </Text>
              </View>
              {item.sizeBytes > 0 && (
                <Text style={styles.metaText} numberOfLines={1}>
                  {formatFileSize(item.sizeBytes)}
                </Text>
              )}
            </View>
            {!isImportable(item) && item.statusReason && (
              <Text style={styles.reasonText} numberOfLines={2}>
                {item.statusReason}
              </Text>
            )}
          </View>
        </TouchableOpacity>
      );
    },
    [c, converting, importSupported, selectedIds, styles, toggleSelected]
  );

  const renderSectionHeader = useCallback(
    ({ section }: { section: BiliSeasonSection }) => (
      <View style={styles.sectionHeader}>
        <FontAwesome6 name="clapperboard" size={12} color={c.accent} />
        <Text style={styles.sectionTitle} numberOfLines={1}>
          {section.title}
        </Text>
        <Text style={styles.sectionCount}>{section.data.length}</Text>
      </View>
    ),
    [c.accent, styles]
  );

  const sections = useMemo<BiliSeasonSection[]>(
    () =>
      (overview?.seasons ?? []).map((season) => ({
        key: season.key,
        title: season.title,
        data: season.episodes,
      })),
    [overview]
  );

  return (
    <Screen backgroundColor={c.background} statusBarStyle={statusBarStyle} safeAreaEdges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
          disabled={converting}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <FontAwesome6 name="chevron-left" size={18} color={c.foreground} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>B站缓存导入</Text>
          <Text style={styles.headerSubtitle}>
            可导入 {importableCount} · 已选 {selectedEpisodes.length}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.iconButton}
          onPress={selectAllImportable}
          disabled={converting || importableCount === 0}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <FontAwesome6 name="circle-check" size={17} color={c.accent} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.iconButton}
          onPress={runScan}
          disabled={scanning || converting}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <FontAwesome6
            name="arrow-rotate-right"
            size={16}
            color={scanning || converting ? c.backgroundTertiary : c.muted}
          />
        </TouchableOpacity>
      </View>

      {!accessGranted && (
        <TouchableOpacity
          style={styles.accessBanner}
          onPress={requestAllFilesAccess}
          activeOpacity={0.8}
        >
          <FontAwesome6 name="folder-tree" size={13} color={c.danger} />
          <Text style={styles.accessBannerText} numberOfLines={2}>
            需要「所有文件访问」权限才能读取B站缓存目录，点击前往开启
          </Text>
          <FontAwesome6 name="chevron-right" size={12} color={c.muted} />
        </TouchableOpacity>
      )}

      {scanning ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={c.accent} />
          <Text style={styles.loadingText}>正在扫描B站缓存目录...</Text>
        </View>
      ) : !accessGranted ? (
        <View style={styles.centerContainer}>
          <FontAwesome6 name="folder-tree" size={48} color={c.muted} />
          <Text style={styles.emptyTitle}>缺少存储权限</Text>
          <Text style={styles.emptyDesc}>
            开启「所有文件访问」后即可读取本机B站App的缓存视频
          </Text>
        </View>
      ) : sections.length === 0 ? (
        <View style={styles.centerContainer}>
          <FontAwesome6 name="box-open" size={48} color={c.muted} />
          <Text style={styles.emptyTitle}>未找到可导入的缓存</Text>
          <Text style={styles.emptyDesc}>
            需先在B站App中离线缓存视频{'\n'}
            缓存目录：Android/data/tv.danmaku.bili/download{'\n'}
            加密或DRM内容无法导入
          </Text>
        </View>
      ) : (
        <>
          <SectionList<BiliEpisode, BiliSeasonSection>
            sections={sections}
            keyExtractor={(item) => item.id}
            renderItem={renderEpisodeRow}
            renderSectionHeader={renderSectionHeader}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            ItemSeparatorComponent={() => <View style={styles.rowSeparator} />}
            ListFooterComponent={
              <View style={styles.footerNote}>
                <FontAwesome6 name="shield-halved" size={11} color={c.muted} />
                <Text style={styles.footerNoteText}>
                  仅处理本机已缓存的未加密内容，仅供个人备份观看；加密与DRM视频无法解密导入
                </Text>
              </View>
            }
          />

          {converting ? (
            <View style={[styles.bottomBar, styles.bottomBarConverting]}>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${Math.round(overallFraction * 100)}%` },
                  ]}
                />
              </View>
              <View style={styles.progressMeta}>
                <Text style={styles.progressTitle} numberOfLines={1}>
                  {progress.currentTitle || '正在处理...'}
                </Text>
                <Text style={styles.progressCount}>
                  {progress.doneCount} / {progress.totalCount}
                </Text>
              </View>
            </View>
          ) : selectedEpisodes.length > 0 && importSupported ? (
            <View style={styles.bottomBar}>
              <TouchableOpacity
                style={styles.convertButton}
                activeOpacity={0.85}
                onPress={startConvert}
              >
                <FontAwesome6
                  name="file-video"
                  size={14}
                  color={c.accentForeground}
                />
                <Text style={styles.convertButtonText}>
                  合并导出（{selectedEpisodes.length}）
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {!importSupported && Platform.OS !== 'android' && (
            <View style={styles.unsupportedBanner}>
              <Text style={styles.unsupportedText}>
                当前平台暂不支持合并导出
              </Text>
            </View>
          )}
        </>
      )}
    </Screen>
  );
}

function createStyles(c: ThemePalette) {
  return StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 20,
      paddingTop: Platform.OS === 'web' ? 20 : 12,
      paddingBottom: 14,
    },
    backButton: {
      width: 38,
      height: 38,
      borderRadius: 12,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      justifyContent: 'center',
      alignItems: 'center',
    },
    iconButton: {
      width: 34,
      height: 34,
      borderRadius: 11,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      justifyContent: 'center',
      alignItems: 'center',
    },
    headerCenter: {
      flex: 1,
    },
    headerTitle: {
      color: c.foreground,
      fontSize: 20,
      fontWeight: '700',
      letterSpacing: -0.3,
    },
    headerSubtitle: {
      color: c.muted,
      fontSize: 12,
      marginTop: 2,
      fontWeight: '500',
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
    centerContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 40,
      paddingBottom: 60,
    },
    loadingText: {
      color: c.muted,
      fontSize: 14,
      marginTop: 16,
    },
    emptyTitle: {
      color: c.foreground,
      fontSize: 17,
      fontWeight: '600',
      marginTop: 18,
      marginBottom: 8,
    },
    emptyDesc: {
      color: c.muted,
      fontSize: 13,
      textAlign: 'center',
      lineHeight: 21,
    },
    listContent: {
      paddingHorizontal: 16,
      paddingBottom: 120,
    },
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
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
    rowSeparator: {
      height: 8,
    },
    episodeRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      backgroundColor: c.surface,
      borderRadius: 12,
      padding: 12,
      borderWidth: 1,
      borderColor: c.border,
    },
    checkbox: {
      marginRight: 10,
      marginTop: 1,
    },
    episodeInfo: {
      flex: 1,
    },
    episodeTitle: {
      color: c.foreground,
      fontSize: 14,
      fontWeight: '600',
      lineHeight: 19,
    },
    episodeMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 5,
      flexWrap: 'wrap',
    },
    qualityBadge: {
      backgroundColor: c.accentSoft,
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 3,
    },
    qualityText: {
      color: c.accent,
      fontSize: 10,
      fontWeight: '700',
    },
    statusBadge: {
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 3,
    },
    statusBadgeAccent: {
      backgroundColor: c.accentSoft,
    },
    statusBadgeDanger: {
      backgroundColor: c.dangerSoft,
    },
    statusBadgeMuted: {
      backgroundColor: c.backgroundTertiary,
    },
    statusText: {
      fontSize: 10,
      fontWeight: '700',
    },
    statusTextAccent: {
      color: c.accent,
    },
    statusTextDanger: {
      color: c.danger,
    },
    statusTextMuted: {
      color: c.muted,
    },
    metaText: {
      color: c.muted,
      fontSize: 11,
      fontWeight: '500',
    },
    reasonText: {
      color: c.muted,
      fontSize: 11,
      lineHeight: 15,
      marginTop: 4,
    },
    footerNote: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 6,
      paddingTop: 16,
      paddingHorizontal: 4,
    },
    footerNoteText: {
      flex: 1,
      color: c.muted,
      fontSize: 11,
      lineHeight: 16,
    },
    bottomBar: {
      position: 'absolute',
      left: 16,
      right: 16,
      bottom: 24,
      borderRadius: 14,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      padding: 12,
    },
    bottomBarConverting: {
      gap: 10,
    },
    progressTrack: {
      height: 5,
      borderRadius: 3,
      backgroundColor: c.backgroundTertiary,
      overflow: 'hidden',
    },
    progressFill: {
      height: '100%',
      borderRadius: 3,
      backgroundColor: c.accent,
    },
    progressMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    progressTitle: {
      flex: 1,
      color: c.foreground,
      fontSize: 12,
      fontWeight: '600',
    },
    progressCount: {
      color: c.muted,
      fontSize: 12,
      fontWeight: '600',
    },
    convertButton: {
      height: 46,
      borderRadius: 12,
      backgroundColor: c.accent,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    convertButtonText: {
      color: c.accentForeground,
      fontSize: 14,
      fontWeight: '700',
    },
    unsupportedBanner: {
      marginHorizontal: 16,
      marginBottom: 12,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: c.backgroundTertiary,
      alignItems: 'center',
    },
    unsupportedText: {
      color: c.muted,
      fontSize: 12,
    },
  });
}
