/**
 * 设置页（任务 #13）
 *
 * 收拢此前散落在首页的设置项：主题切换（原首页循环点按）、图片网格列数、
 * 缩略图缓存管理、关于信息。整体液态玻璃风格。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DeviceEventEmitter,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import * as Application from 'expo-application';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCSSVariable } from 'uniwind';
import { Screen } from '@/components/Screen';
import { GlassView, GlowBackground, PressableScale } from '@/components/glass';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useThemePreference, type ThemePreference } from '@/contexts/ThemeContext';
import {
  PHOTO_COLUMN_OPTIONS,
  PHOTO_COLUMNS,
  PHOTO_COLUMNS_STORAGE_KEY,
  ThemePalette,
} from '../home/shared';
import { PHOTO_COLUMNS_CHANGED_EVENT } from '@/hooks/usePhotoGridColumns';
import { clearThumbnailCache, getThumbnailCacheSize } from '@/utils/thumbnailCache';
import { formatFileSize } from '@/utils/format';

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: string }[] = [
  { value: 'system', label: '跟随系统', icon: 'circle-half-stroke' },
  { value: 'light', label: '浅色', icon: 'sun' },
  { value: 'dark', label: '深色', icon: 'moon' },
];

const MODEL_LIST = [
  { name: '图片超分', model: 'Real-ESRGAN x4v3（通用降噪）' },
  { name: '视频超分', model: 'Real-ESRGAN animevideov3（2x）' },
  { name: '视频插帧', model: 'RIFE v4.6 光流模型' },
  { name: '播放器', model: 'libmpv + Anime4K 实时增强' },
];

function SectionTitle({ title, c }: { title: string; c: ThemePalette }) {
  return (
    <Text style={{ color: c.muted, fontSize: 12, fontWeight: '700', marginTop: 20, marginBottom: 8, marginLeft: 4, letterSpacing: 0.6 }}>
      {title}
    </Text>
  );
}

export default function SettingsScreen() {
  const router = useSafeRouter();
  const { preference, setPreference } = useThemePreference();
  const [photoColumns, setPhotoColumns] = useState<number>(PHOTO_COLUMNS);
  const [cacheBytes, setCacheBytes] = useState(0);
  const [clearing, setClearing] = useState(false);

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

  const statusBarStyle = preference === 'light' ? 'dark' : 'light';

  useEffect(() => {
    AsyncStorage.getItem(PHOTO_COLUMNS_STORAGE_KEY)
      .then((raw) => {
        const value = Number(raw);
        if (PHOTO_COLUMN_OPTIONS.includes(value as (typeof PHOTO_COLUMN_OPTIONS)[number])) {
          setPhotoColumns(value);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setCacheBytes(getThumbnailCacheSize());
  }, []);

  const applyColumns = useCallback((cols: number) => {
    setPhotoColumns(cols);
    AsyncStorage.setItem(PHOTO_COLUMNS_STORAGE_KEY, String(cols)).catch(() => undefined);
    // 广播给首页 usePhotoGridColumns，列数即时生效
    DeviceEventEmitter.emit(PHOTO_COLUMNS_CHANGED_EVENT, cols);
  }, []);

  const handleClearCache = useCallback(() => {
    if (clearing) return;
    setClearing(true);
    const ok = clearThumbnailCache();
    setCacheBytes(0);
    setClearing(false);
    Toast.show({
      type: ok ? 'success' : 'error',
      text1: ok ? '已清空缩略图缓存' : '清理失败，请重试',
    });
  }, [clearing]);

  return (
    <Screen backgroundColor={c.background} statusBarStyle={statusBarStyle} safeAreaEdges={['top', 'left', 'right', 'bottom']}>
      <GlowBackground colors={[c.accent, '#22D3EE', '#A78BFA']} opacity={0.3} />
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.iconButton}
          onPress={() => router.back()}
          accessibilityLabel="返回"
        >
          <FontAwesome6 name="chevron-left" size={17} color={c.foreground} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: c.foreground }]}>设置</Text>
        <View style={styles.iconButton} />
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} showsVerticalScrollIndicator={false}>
        <SectionTitle title="外观" c={c} />
        <GlassView palette={c} radius={18} style={styles.sectionCard}>
          {THEME_OPTIONS.map((option) => {
            const active = preference === option.value;
            return (
              <PressableScale key={option.value} onPress={() => setPreference(option.value)}>
                <View style={[styles.row, active && { backgroundColor: c.accentSoft }]}>
                  <FontAwesome6 name={option.icon as never} size={15} color={active ? c.accent : c.muted} />
                  <Text style={[styles.rowText, { color: active ? c.accent : c.foreground }]}>{option.label}</Text>
                  {active && <FontAwesome6 name="check" size={13} color={c.accent} />}
                </View>
              </PressableScale>
            );
          })}
        </GlassView>

        <SectionTitle title="图片网格列数" c={c} />
        <GlassView palette={c} radius={18} style={styles.sectionCard}>
          <View style={styles.chipsRow}>
            {PHOTO_COLUMN_OPTIONS.map((cols) => {
              const active = cols === photoColumns;
              return (
                <PressableScale key={cols} onPress={() => applyColumns(cols)}>
                  <View
                    style={[
                      styles.chip,
                      active
                        ? { backgroundColor: c.accent }
                        : { backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: c.border },
                    ]}
                  >
                    <Text style={[styles.chipText, { color: active ? c.accentForeground : c.muted }]}>{cols}</Text>
                  </View>
                </PressableScale>
              );
            })}
          </View>
          <Text style={[styles.hint, { color: c.muted }]}>首页图片列表默认列数，修改即时生效；列表内仍支持双指捏合缩放。</Text>
        </GlassView>

        <SectionTitle title="缓存" c={c} />
        <GlassView palette={c} radius={18} style={styles.sectionCard}>
          <View style={styles.row}>
            <FontAwesome6 name="image" size={15} color={c.muted} />
            <Text style={[styles.rowText, { color: c.foreground }]}>图片缩略图缓存</Text>
            <Text style={[styles.rowMeta, { color: c.muted }]}>{formatFileSize(cacheBytes)}</Text>
          </View>
          <View style={styles.divider} />
          <PressableScale onPress={handleClearCache}>
            <View style={styles.row}>
              <FontAwesome6 name="broom" size={15} color={c.danger} />
              <Text style={[styles.rowText, { color: c.danger }]}>
                {clearing ? '清理中…' : '清理缩略图缓存'}
              </Text>
            </View>
          </PressableScale>
          <Text style={[styles.hint, { color: c.muted }]}>清理后列表重新按需生成缩略图，不影响原图与超分结果。</Text>
        </GlassView>

        <SectionTitle title="关于" c={c} />
        <GlassView palette={c} radius={18} style={styles.sectionCard}>
          <View style={styles.row}>
            <FontAwesome6 name="circle-info" size={15} color={c.muted} />
            <Text style={[styles.rowText, { color: c.foreground }]}>版本</Text>
            <Text style={[styles.rowMeta, { color: c.muted }]}>{Application.nativeApplicationVersion ?? 'dev'}</Text>
          </View>
          <View style={styles.divider} />
          {MODEL_LIST.map((item) => (
            <View key={item.name} style={styles.modelRow}>
              <Text style={[styles.modelName, { color: c.foreground }]}>{item.name}</Text>
              <Text style={[styles.modelValue, { color: c.muted }]}>{item.model}</Text>
            </View>
          ))}
          <Text style={[styles.hint, { color: c.muted }]}>所有 AI 推理在手机本地完成，不联网、不上传。</Text>
        </GlassView>

        <View style={{ height: 32 }} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    height: 58,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconButton: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flex: 1,
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  sectionCard: {
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 13,
    paddingHorizontal: 4,
  },
  rowText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
  },
  rowMeta: {
    fontSize: 13,
    fontWeight: '500',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.1)',
    marginHorizontal: 4,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  chip: {
    minWidth: 36,
    height: 32,
    paddingHorizontal: 10,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: {
    fontSize: 13,
    fontWeight: '700',
  },
  hint: {
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: 4,
    paddingBottom: 10,
    paddingTop: 2,
  },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 4,
  },
  modelName: {
    width: 84,
    fontSize: 13,
    fontWeight: '600',
  },
  modelValue: {
    flex: 1,
    fontSize: 12,
  },
});
