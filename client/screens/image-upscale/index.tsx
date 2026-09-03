import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { useNavigation } from 'expo-router';
import { Screen } from '@/components/Screen';
import { GlowBackground } from '@/components/glass';
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
  const navigation = useNavigation();
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

  // 页面是否仍挂载：native 推理跑在后台线程池，退出页面不会中断，产物照常落盘
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 处理中拦截返回手势/物理返回键：产物不会丢，只是看不到结果，让用户自主选择
  // 用 React Navigation 的 beforeRemove（expo-router 底层即 RN），native 端原生支持；
  // expo-router 的 usePreventRemove 目前只有 web 实现，不能用于 Android
  useEffect(() => {
    if (!running) return;
    const unsubscribe = navigation.addListener('beforeRemove', (event: any) => {
      event.preventDefault();
      Alert.alert(
        'AI 处理中',
        '处理会在后台继续，完成后自动保存到相册「Pictures/夜映/AI」，退出不会丢失结果。',
        [
          { text: '继续等待', style: 'cancel' },
          {
            text: '离开页面',
            style: 'destructive',
            onPress: () => navigation.dispatch(event.data.action),
          },
        ]
      );
    });
    return unsubscribe;
  }, [navigation, running]);

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
      // 即使已离开页面也提示：native 侧已完成落盘，用户需要知道结果
      Toast.show({
        type: 'success',
        text1: '超分完成',
        text2: `已保存到相册 Pictures/夜映/AI · ${next.width} × ${next.height}`,
      });
      if (!mountedRef.current) return;
      setResult(next);
      setPhase('done');
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : '超分失败，请重试');
      setPhase('failed');
    }
  }, [running, scale, uri]);

  return (
    <Screen backgroundColor="#0A0A0F" statusBarStyle="light" safeAreaEdges={['top', 'left', 'right', 'bottom']}>
      {/* 液态玻璃光环境 */}
      <GlowBackground colors={['#4F46E5', '#22D3EE', '#A78BFA']} opacity={0.3} />
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
                  <Text style={styles.previewMaskHint}>需要几十秒，可退出等待，完成后自动存入相册</Text>
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
            key={viewerMode}
            uri={viewerMode === 'result' && result ? result.outputUri : (uri ?? '')}
            imageWidth={viewerMode === 'result' && result ? result.width : width}
            imageHeight={viewerMode === 'result' && result ? result.height : height}
          />

          <View style={styles.viewerFooter}>
            <FontAwesome6 name="hand" size={11} color="#64748B" />
            <Text style={styles.viewerFooterText}>双指缩放 · 单指拖动 · 双击放大</Text>
          </View>
          </View>
        </GestureHandlerRootView>
      </Modal>
    </Screen>
  );
}

/** 全屏查看器：双指缩放 + 单指拖动 + 双击放大（RN Animated + Gesture，不依赖 reanimated） */
const MAX_ZOOM = 8;
const DOUBLE_TAP_ZOOM = 2.5;

function ZoomableImage({
  uri,
  imageWidth,
  imageHeight,
}: {
  uri: string;
  imageWidth?: number;
  imageHeight?: number;
}) {
  const zoom = useRef(new Animated.Value(1)).current;
  const panX = useRef(new Animated.Value(0)).current;
  const panY = useRef(new Animated.Value(0)).current;
  // 当前值与手势基准：用 ref 保存，避免 JS 线程回调里读到过期闭包值
  const cur = useRef({ scale: 1, x: 0, y: 0 }).current;
  const base = useRef({ scale: 1, x: 0, y: 0 }).current;
  const [layout, setLayout] = useState({ w: 0, h: 0 });

  // 图片 contain 后的实际显示尺寸，决定拖动边界
  const display = useMemo(() => {
    if (!layout.w || !layout.h) return { w: 0, h: 0 };
    if (!imageWidth || !imageHeight) return { w: layout.w, h: layout.h };
    const fit = Math.min(layout.w / imageWidth, layout.h / imageHeight);
    return { w: imageWidth * fit, h: imageHeight * fit };
  }, [layout.w, layout.h, imageWidth, imageHeight]);

  // 限制平移范围：只允许在放大后多出来的区域内移动，防止把图拖出屏幕
  const clampPan = useCallback(
    (scale: number, x: number, y: number) => {
      const maxX = Math.max(0, (display.w * scale - layout.w) / 2);
      const maxY = Math.max(0, (display.h * scale - layout.h) / 2);
      return {
        x: Math.max(-maxX, Math.min(maxX, x)),
        y: Math.max(-maxY, Math.min(maxY, y)),
      };
    },
    [display.w, display.h, layout.w, layout.h]
  );

  const apply = useCallback(
    (scale: number, x: number, y: number) => {
      const clamped = clampPan(scale, x, y);
      cur.scale = scale;
      cur.x = clamped.x;
      cur.y = clamped.y;
      zoom.setValue(scale);
      panX.setValue(clamped.x);
      panY.setValue(clamped.y);
    },
    [clampPan, cur, panX, panY, zoom]
  );

  /** 停掉进行中的动画（复位/双击动画互相打断时的竞态根源） */
  const stopAnim = useCallback(() => {
    zoom.stopAnimation();
    panX.stopAnimation();
    panY.stopAnimation();
  }, [panX, panY, zoom]);

  /**
   * 以动画过渡到目标变换（双击放大/复位统一走这里）。
   * 之前双击直接 setValue 瞬跳 + 与 spring 复位竞争 → 画面闪跳。
   */
  const animateTo = useCallback(
    (scale: number, x: number, y: number) => {
      const clamped = clampPan(scale, x, y);
      stopAnim();
      Animated.parallel([
        Animated.timing(zoom, { toValue: scale, duration: 220, useNativeDriver: true }),
        Animated.timing(panX, { toValue: clamped.x, duration: 220, useNativeDriver: true }),
        Animated.timing(panY, { toValue: clamped.y, duration: 220, useNativeDriver: true }),
      ]).start();
      cur.scale = scale;
      cur.x = clamped.x;
      cur.y = clamped.y;
    },
    [clampPan, cur, panX, panY, stopAnim, zoom]
  );

  /**
   * 计算以屏幕焦点为中心的缩放目标（不落地，供动画使用）。
   * 推导：屏幕位置 P = center + pan + C·S，保持 P 不变时 pan' = f − (f − pan)·(S'/S)
   */
  const computeZoomTarget = useCallback(
    (nextScale: number, focusX: number, focusY: number) => {
      const s = Math.max(1, Math.min(MAX_ZOOM, nextScale));
      const fx = focusX - layout.w / 2;
      const fy = focusY - layout.h / 2;
      const ratio = s / (base.scale || 1);
      return {
        scale: s,
        x: fx - (fx - base.x) * ratio,
        y: fy - (fy - base.y) * ratio,
      };
    },
    [base, layout.h, layout.w]
  );

  // 捏合跟手：目标即时落地（不能有动画延迟）
  const zoomAt = useCallback(
    (nextScale: number, focusX: number, focusY: number) => {
      const target = computeZoomTarget(nextScale, focusX, focusY);
      apply(target.scale, target.x, target.y);
    },
    [apply, computeZoomTarget]
  );

  const reset = useCallback(() => {
    stopAnim();
    Animated.parallel([
      Animated.spring(zoom, { toValue: 1, useNativeDriver: true, friction: 7 }),
      Animated.spring(panX, { toValue: 0, useNativeDriver: true, friction: 7 }),
      Animated.spring(panY, { toValue: 0, useNativeDriver: true, friction: 7 }),
    ]).start();
    cur.scale = 1;
    cur.x = 0;
    cur.y = 0;
  }, [cur, panX, panY, stopAnim, zoom]);

  const pinch = useMemo(
    () =>
      Gesture.Pinch()
        .runOnJS(true)
        .onStart(() => {
          base.scale = cur.scale;
          base.x = cur.x;
          base.y = cur.y;
        })
        .onUpdate((event) => {
          zoomAt(base.scale * event.scale, event.focalX, event.focalY);
        })
        .onEnd(() => {
          // 松手不再强制回弹：仅当倍率接近 1 时吸附复位，其余保持当前倍率供查看
          if (cur.scale < 1.05) reset();
        }),
    [base, cur, reset, zoomAt]
  );

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .maxPointers(1) // 单指拖动，双指时交给 Pinch
        .runOnJS(true)
        .onStart(() => {
          base.x = cur.x;
          base.y = cur.y;
        })
        .onUpdate((event) => {
          if (cur.scale <= 1.01) return; // 未放大时不允许拖动
          apply(cur.scale, base.x + event.translationX, base.y + event.translationY);
        }),
    [apply, base, cur]
  );

  const doubleTap = useMemo(
    () =>
      Gesture.Tap()
        .numberOfTaps(2)
        .maxDistance(24)
        .runOnJS(true)
        .onEnd((event) => {
          if (cur.scale > 1.05) {
            reset();
            return;
          }
          base.scale = cur.scale;
          base.x = cur.x;
          base.y = cur.y;
          // 动画放大而非瞬跳：消除双击时画面闪跳
          const target = computeZoomTarget(DOUBLE_TAP_ZOOM, event.x, event.y);
          animateTo(target.scale, target.x, target.y);
        }),
    [animateTo, base, computeZoomTarget, cur, reset]
  );

  const gesture = useMemo(
    () => Gesture.Simultaneous(pinch, pan, doubleTap),
    [doubleTap, pan, pinch]
  );

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        style={styles.viewerCanvas}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setLayout({ w: width, h: height });
        }}
      >
        <Animated.Image
          source={{ uri: uri || undefined }}
          style={[
            styles.viewerImage,
            { transform: [{ translateX: panX }, { translateY: panY }, { scale: zoom }] },
          ]}
          resizeMode="contain"
        />
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
    borderBottomColor: 'rgba(255,255,255,0.12)',
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
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.3)',
    borderLeftColor: 'rgba(255,255,255,0.16)',
    borderRightColor: 'rgba(255,255,255,0.08)',
    borderBottomColor: 'rgba(255,255,255,0.05)',
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
    backgroundColor: 'rgba(255,255,255,0.06)',
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
    borderBottomColor: 'rgba(255,255,255,0.12)',
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
    borderBottomColor: 'rgba(255,255,255,0.12)',
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
    backgroundColor: 'rgba(255,255,255,0.06)',
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
    borderWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.42)',
    borderLeftColor: 'rgba(255,255,255,0.2)',
    borderBottomColor: 'rgba(255,255,255,0.08)',
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
