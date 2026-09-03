import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { Screen } from '@/components/Screen';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import {
  isVideoAiSupported,
  upscaleImage,
  type ImageUpscaleResult,
} from '@/modules/expo-video-ai/src';

type Phase = 'idle' | 'running' | 'done' | 'failed';

interface RouteParams {
  uri?: string;
  title?: string;
  width?: number;
  height?: number;
}

export default function ImageUpscaleScreen() {
  const router = useSafeRouter();
  const { uri, title, width, height } = useSafeSearchParams<RouteParams>();
  const [scale, setScale] = useState<2 | 4>(4);
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<ImageUpscaleResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<'original' | 'result'>('result');
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerMode, setViewerMode] = useState<'original' | 'result'>('result');
  const supported = useMemo(() => isVideoAiSupported(), []);

  const sourceSize = useMemo(() => {
    if (!width || !height) return null;
    return `${width} × ${height}`;
  }, [width, height]);

  const outputSize = useMemo(() => {
    if (!width || !height) return null;
    return `${width * scale} × ${height * scale}`;
  }, [width, height, scale]);

  const running = phase === 'running';

  const openViewer = useCallback(() => {
    setViewerMode(previewMode === 'result' && result ? 'result' : 'original');
    setViewerVisible(true);
  }, [previewMode, result]);

  const closeViewer = useCallback(() => setViewerVisible(false), []);

  const changeScale = useCallback((next: 2 | 4) => {
    if (running) return;
    setScale(next);
    if (phase === 'done') {
      setPhase('idle');
      setResult(null);
      setPreviewMode('result');
    }
  }, [phase, running]);

  const start = useCallback(async () => {
    if (!uri || running) return;
    setPhase('running');
    setError(null);
    try {
      const next = await upscaleImage({ inputUri: uri, scale });
      setResult(next);
      setPhase('done');
      Toast.show({
        type: 'success',
        text1: '超分完成',
        text2: `已保存到相册 Pictures/夜映/AI · ${next.width} × ${next.height}`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '超分失败，请重试');
      setPhase('failed');
    }
  }, [running, scale, uri]);

  return (
    <Screen backgroundColor="#0A0A0F" statusBarStyle="light" safeAreaEdges={['top', 'left', 'right', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.iconButton}
          onPress={() => router.back()}
          accessibilityLabel="返回"
        >
          <FontAwesome6 name="chevron-left" size={18} color="#E2E8F0" />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>图片超分</Text>
        <View style={styles.iconButton} />
      </View>

      {!supported ? (
        <View style={styles.stateView}>
          <FontAwesome6 name="triangle-exclamation" size={28} color="#FBBF24" />
          <Text style={styles.stateTitle}>当前设备不可用</Text>
          <Text style={styles.stateText}>需要支持 Vulkan 的 arm64 Android 真机。</Text>
        </View>
      ) : !uri ? (
        <View style={styles.stateView}>
          <FontAwesome6 name="circle-exclamation" size={28} color="#FCA5A5" />
          <Text style={styles.stateTitle}>无法读取图片</Text>
        </View>
      ) : (
        <View style={styles.content}>
          {/* 预览区：完成后可按原图/效果切换对比，否则显示原图；点击放大查看细节 */}
          <TouchableOpacity
            style={styles.previewTouch}
            activeOpacity={0.95}
            onPress={openViewer}
            disabled={running}
            accessibilityLabel="放大查看"
          >
            <View style={styles.preview}>
              {result && phase === 'done' && previewMode === 'result' ? (
                <Image
                  source={{ uri: result.outputUri }}
                  style={styles.previewImage}
                  resizeMode="contain"
                />
              ) : (
                <Image
                  source={{ uri }}
                  style={styles.previewImage}
                  resizeMode="contain"
                />
              )}
              {running && (
                <View style={styles.previewMask}>
                  <ActivityIndicator size="large" color="#6366F1" />
                  <Text style={styles.previewMaskText}>AI 超分处理中…</Text>
                  <Text style={styles.previewMaskHint}>4x 模式可能需要几十秒，请勿退出</Text>
                </View>
              )}
              {phase === 'done' && result && previewMode === 'original' && (
                <View style={styles.originalBadge}>
                  <Text style={styles.originalBadgeText}>原图</Text>
                </View>
              )}
              {phase === 'done' && result && previewMode === 'result' && (
                <View style={styles.doneBadge}>
                  <FontAwesome6 name="check" size={10} color="#FFFFFF" />
                  <Text style={styles.doneBadgeText}>AI 超分</Text>
                </View>
              )}
            </View>
            <View style={styles.zoomHint}>
              <FontAwesome6 name="magnifying-glass-plus" size={10} color="#94A3B8" />
              <Text style={styles.zoomHintText}>点击放大查看细节</Text>
            </View>
          </TouchableOpacity>

          {phase === 'done' && result && (
            <View style={styles.compareRow}>
              <Text style={styles.compareLabel}>对比</Text>
              <View style={styles.compareSeg}>
                {(
                  [
                    { value: 'original', label: '原图' },
                    { value: 'result', label: `超分 ${scale}x` },
                  ] as const
                ).map((option) => {
                  const selected = previewMode === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      style={[styles.compareItem, selected && styles.compareItemActive]}
                      onPress={() => setPreviewMode(option.value)}
                    >
                      <Text
                        style={[styles.compareText, selected && styles.compareTextActive]}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}

          <View style={styles.fileRow}>
            <View style={styles.fileIcon}>
              <FontAwesome6 name="image" size={15} color="#A5B4FC" />
            </View>
            <View style={styles.fileTextGroup}>
              <Text style={styles.fileTitle} numberOfLines={1}>{title || '图片'}</Text>
              <Text style={styles.fileMeta} numberOfLines={1}>
                {sourceSize || '图片'}
                {phase === 'done' && result
                  ? ` → ${result.width} × ${result.height}`
                  : ''}
              </Text>
            </View>
          </View>

          <View style={styles.settings}>
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>放大倍率</Text>
              <View style={styles.segmented}>
                {(
                  [
                    { value: 2, label: '2x', desc: '快速' },
                    { value: 4, label: '4x', desc: '极致' },
                  ] as const
                ).map((option) => {
                  const selected = scale === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      style={[styles.segment, selected && styles.segmentSelected]}
                      onPress={() => changeScale(option.value)}
                      disabled={running}
                    >
                      <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
                        {option.label}
                      </Text>
                      <Text style={[styles.segmentDesc, selected && styles.segmentDescSelected]}>
                        {option.desc}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          </View>

          <View style={styles.outputRow}>
            <FontAwesome6 name="expand" size={12} color="#94A3B8" />
            <Text style={styles.outputHint}>
              {phase === 'done' && result
                ? `已输出 ${result.width} × ${result.height}`
                : `输出 ${outputSize || '自动'} · 保存为 PNG`}
            </Text>
          </View>
          <Text style={styles.modelHint}>
            Real-ESRGAN x4v3 通用降噪模型（ncnn Vulkan 加速），专门清除模糊与压缩伪影，超大图会先等比缩放至安全尺寸再超分，避免内存溢出。
          </Text>

          {phase === 'failed' && error && (
            <View style={styles.errorBox}>
              <FontAwesome6 name="circle-exclamation" size={13} color="#FCA5A5" />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {phase === 'done' && result && (
            <View style={styles.doneBox}>
              <FontAwesome6 name="circle-check" size={13} color="#4ADE80" />
              <Text style={styles.doneText}>
                已保存到相册「Pictures/夜映/AI」目录
              </Text>
            </View>
          )}

          <TouchableOpacity
            style={[styles.startButton, running && styles.startButtonDisabled]}
            onPress={start}
            disabled={running}
            accessibilityLabel="开始超分"
          >
            {running ? (
              <>
                <ActivityIndicator size="small" color="#FFFFFF" />
                <Text style={styles.startButtonText}>处理中…</Text>
              </>
            ) : (
              <>
                <FontAwesome6 name="wand-magic-sparkles" size={15} color="#FFFFFF" />
                <Text style={styles.startButtonText}>
                  {phase === 'done' ? '重新超分' : phase === 'failed' ? '重试超分' : '开始超分'}
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}

      <Modal
        visible={viewerVisible}
        transparent={false}
        animationType="fade"
        onRequestClose={closeViewer}
      >
        {/* Modal 是独立原生窗口，手势配置不会从根视图传入，必须内层再包 GestureHandlerRootView */}
        <GestureHandlerRootView style={styles.viewerRoot}>
          <View style={styles.viewer}>
          <View style={styles.viewerHeader}>
            <TouchableOpacity
              style={styles.viewerClose}
              onPress={closeViewer}
              accessibilityLabel="关闭预览"
            >
              <FontAwesome6 name="xmark" size={17} color="#F8FAFC" />
            </TouchableOpacity>
            {phase === 'done' && result && (
              <View style={styles.viewerSeg}>
                {(
                  [
                    { value: 'original', label: '原图' },
                    { value: 'result', label: `超分 ${scale}x` },
                  ] as const
                ).map((option) => {
                  const selected = viewerMode === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      style={[styles.viewerSegItem, selected && styles.viewerSegItemActive]}
                      onPress={() => setViewerMode(option.value)}
                    >
                      <Text
                        style={[styles.viewerSegText, selected && styles.viewerSegTextActive]}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>

          <ZoomableImage
            uri={viewerMode === 'result' && result ? result.outputUri : (uri ?? '')}
          />

          <View style={styles.viewerFooter}>
            <FontAwesome6 name="hand" size={11} color="#64748B" />
            <Text style={styles.viewerFooterText}>双指捏合缩放 · 查看真实细节</Text>
          </View>
          </View>
        </GestureHandlerRootView>
      </Modal>
    </Screen>
  );
}

/** 全屏双指缩放查看器（RN Animated + Gesture.Pinch，不依赖 reanimated） */
function ZoomableImage({ uri }: { uri: string }) {
  const zoom = useRef(new Animated.Value(1)).current;
  const zoomRef = useRef(1);

  const pinch = useMemo(
    () =>
      Gesture.Pinch()
        .runOnJS(true)
        .onStart(() => {
          zoomRef.current = Math.max(1, zoomRef.current);
        })
        .onUpdate((event) => {
          const next = Math.max(1, Math.min(8, zoomRef.current * event.scale));
          zoom.setValue(next);
        })
        .onEnd(() => {
          zoomRef.current = 1;
          Animated.spring(zoom, { toValue: 1, useNativeDriver: true, friction: 6 }).start();
        }),
    [zoom]
  );

  return (
    <GestureDetector gesture={pinch}>
      <Animated.View style={[styles.viewerCanvas, { transform: [{ scale: zoom }] }]}>
        <Image source={{ uri: uri || undefined }} style={styles.viewerImage} resizeMode="contain" />
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  header: {
    height: 58,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#27272F',
  },
  iconButton: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flex: 1,
    color: '#F8FAFC',
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  content: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  previewTouch: {
    marginBottom: 4,
  },
  zoomHint: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 6,
  },
  zoomHintText: {
    color: '#94A3B8',
    fontSize: 11,
  },
  viewer: {
    flex: 1,
    backgroundColor: '#000000',
  },
  viewerRoot: {
    flex: 1,
  },
  viewerHeader: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  viewerClose: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerSeg: {
    flexDirection: 'row',
    height: 34,
    padding: 2,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.12)',
    gap: 2,
  },
  viewerSegItem: {
    minWidth: 68,
    paddingHorizontal: 10,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 6,
  },
  viewerSegItemActive: {
    backgroundColor: '#4F46E5',
  },
  viewerSegText: {
    color: '#CBD5E1',
    fontSize: 13,
    fontWeight: '600',
  },
  viewerSegTextActive: {
    color: '#FFFFFF',
  },
  viewerCanvas: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  viewerImage: {
    width: '100%',
    height: '100%',
  },
  viewerFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingBottom: 24,
    paddingTop: 8,
  },
  viewerFooterText: {
    color: '#64748B',
    fontSize: 12,
  },
  preview: {
    height: 320,
    borderRadius: 12,
    backgroundColor: '#14141C',
    borderWidth: 1,
    borderColor: '#27272F',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
  previewMask: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(10,10,15,0.82)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  previewMaskText: {
    color: '#F1F5F9',
    fontSize: 15,
    fontWeight: '700',
    marginTop: 4,
  },
  previewMaskHint: {
    color: '#94A3B8',
    fontSize: 12,
  },
  doneBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(22,163,74,0.9)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
  },
  doneBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  originalBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    backgroundColor: 'rgba(71,85,105,0.9)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
  },
  originalBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  compareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  compareLabel: {
    color: '#CBD5E1',
    fontSize: 13,
    fontWeight: '600',
  },
  compareSeg: {
    flexDirection: 'row',
    height: 30,
    padding: 2,
    borderRadius: 6,
    backgroundColor: '#1A1A22',
    gap: 2,
  },
  compareItem: {
    minWidth: 62,
    paddingHorizontal: 10,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 4,
  },
  compareItemActive: {
    backgroundColor: '#4F46E5',
  },
  compareText: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
  },
  compareTextActive: {
    color: '#FFFFFF',
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#27272F',
  },
  fileIcon: {
    width: 38,
    height: 38,
    borderRadius: 6,
    backgroundColor: '#1E1B4B',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  fileTextGroup: {
    flex: 1,
  },
  fileTitle: {
    color: '#F1F5F9',
    fontSize: 15,
    fontWeight: '700',
  },
  fileMeta: {
    color: '#94A3B8',
    fontSize: 12,
    marginTop: 4,
  },
  settings: {
    marginTop: 4,
  },
  settingRow: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#27272F',
  },
  settingLabel: {
    color: '#CBD5E1',
    fontSize: 14,
    fontWeight: '600',
  },
  segmented: {
    flexDirection: 'row',
    height: 40,
    padding: 2,
    borderRadius: 8,
    backgroundColor: '#1A1A22',
    gap: 2,
  },
  segment: {
    minWidth: 62,
    paddingHorizontal: 10,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 6,
  },
  segmentSelected: {
    backgroundColor: '#4F46E5',
  },
  segmentText: {
    color: '#94A3B8',
    fontSize: 13,
    fontWeight: '700',
  },
  segmentTextSelected: {
    color: '#FFFFFF',
  },
  segmentDesc: {
    color: '#64748B',
    fontSize: 10,
    marginTop: 1,
  },
  segmentDescSelected: {
    color: '#C7D2FE',
  },
  outputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 14,
  },
  outputHint: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
  },
  modelHint: {
    color: '#64748B',
    fontSize: 11,
    lineHeight: 17,
    marginTop: 6,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 14,
    backgroundColor: 'rgba(252,165,165,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(252,165,165,0.2)',
    borderRadius: 8,
    padding: 10,
  },
  errorText: {
    flex: 1,
    color: '#FCA5A5',
    fontSize: 12,
    lineHeight: 18,
  },
  doneBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 14,
    backgroundColor: 'rgba(74,222,128,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.25)',
    borderRadius: 8,
    padding: 10,
  },
  doneText: {
    flex: 1,
    color: '#86EFAC',
    fontSize: 12,
    lineHeight: 18,
  },
  startButton: {
    marginTop: 'auto',
    marginBottom: Platform.OS === 'web' ? 24 : 16,
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    backgroundColor: '#4F46E5',
    borderRadius: 6,
  },
  startButtonDisabled: {
    opacity: 0.55,
  },
  startButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  stateView: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  stateTitle: {
    color: '#F1F5F9',
    fontSize: 16,
    fontWeight: '700',
  },
  stateText: {
    color: '#94A3B8',
    fontSize: 13,
    textAlign: 'center',
  },
});
