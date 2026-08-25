import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  PanResponder,
  LayoutChangeEvent,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import * as NavigationBar from 'expo-navigation-bar';
import * as Brightness from 'expo-brightness';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { setStatusBarHidden } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  AppVideo,
  ENHANCEMENT_LEVELS,
  isMpvSupported,
  type AppVideoRef,
  type EnhancementLevel,
} from '@/components/AppVideo';
import { Screen } from '@/components/Screen';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import { formatDuration, getQualityLabel } from '@/utils/format';

const SCALE_MODE_OPTIONS = [
  { mode: 'contain', label: '默认' },
  { mode: 'cover', label: '填充' },
  { mode: 'stretch', label: '拉伸' },
] as const;

const MIN_VIDEO_SCALE = 0.5;
const MAX_VIDEO_SCALE = 3;
const DOUBLE_TAP_INTERVAL_MS = 280;
const TAP_SLOP_PX = 8;
const LONG_PRESS_DURATION_MS = 450;
const LONG_PRESS_RATE_OPTIONS = [1.5, 2.0, 3.0];
const BRIGHTNESS_SENSITIVITY = 1.4;
const VOLUME_SENSITIVITY = 1;

const touchDistance = (
  a: { pageX: number; pageY: number },
  b: { pageX: number; pageY: number }
) => Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);

const centroidOf = (touches: ReadonlyArray<{ pageX: number; pageY: number }>) => {
  let x = 0;
  let y = 0;
  touches.forEach((touch) => {
    x += touch.pageX;
    y += touch.pageY;
  });
  return { x: x / touches.length, y: y / touches.length };
};

export default function PlayerScreen() {
  const router = useSafeRouter();
  const insets = useSafeAreaInsets();
  const { uri, title, duration: durationParam } = useSafeSearchParams<{
    uri?: string;
    title: string;
    duration: number;
  }>();

  const videoRef = useRef<AppVideoRef>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(durationParam ? durationParam * 1000 : 0);
  const [showControls, setShowControls] = useState(true);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [volumeLevel, setVolumeLevel] = useState(1);
  const [enhancement, setEnhancement] = useState<EnhancementLevel>('off');
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [engineFallbackReason, setEngineFallbackReason] = useState<string | null>(null);
  const hideControlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPlayingRef = useRef(isPlaying);
  const isMutedRef = useRef(isMuted);
  const [progressBarWidth, setProgressBarWidth] = useState(0);
  const isAndroid = Platform.OS === 'android';

  const [scaleModeIndex, setScaleModeIndex] = useState(0);
  const scaleMode = SCALE_MODE_OPTIONS[scaleModeIndex].mode;
  const [videoScale, setVideoScale] = useState(1);
  const [videoOffset, setVideoOffset] = useState({ x: 0, y: 0 });
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const videoTransformRef = useRef({ scale: 1, offset: { x: 0, y: 0 } });
  const containerSizeRef = useRef(containerSize);
  const gestureRef = useRef({
    activeTouches: 0,
    moved: false,
    longPressActive: false,
    adjustSide: 'none' as 'none' | 'brightness' | 'volume',
    startBrightness: 1,
    startVolume: 1,
    startDistance: 0,
    startScale: 1,
    startCentroid: { x: 0, y: 0 },
    startOffset: { x: 0, y: 0 },
    startPage: { x: 0, y: 0 },
  });
  const lastTapAtRef = useRef(0);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [adjustIndicator, setAdjustIndicator] = useState<{
    side: 'brightness' | 'volume';
    value: number;
  } | null>(null);
  const adjustHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const brightnessRef = useRef(1);
  const volumeRef = useRef(1);

  const [videoDimensions, setVideoDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [isPlayerLandscape, setIsPlayerLandscape] = useState(false);

  const playbackRates = useMemo(() => [0.5, 0.75, 1.0, 1.25, 1.5, 2.0], []);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    setPlaybackError(null);
    setEngineFallbackReason(null);
  }, [uri]);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    videoTransformRef.current = { scale: videoScale, offset: videoOffset };
  }, [videoOffset, videoScale]);

  useEffect(() => {
    containerSizeRef.current = containerSize;
  }, [containerSize]);

  const clampVideoOffset = useCallback(
    (offset: { x: number; y: number }, scale: number) => {
      const maxX = Math.max(0, ((scale - 1) * containerSizeRef.current.width) / 2);
      const maxY = Math.max(0, ((scale - 1) * containerSizeRef.current.height) / 2);
      return {
        x: Math.max(-maxX, Math.min(maxX, offset.x)),
        y: Math.max(-maxY, Math.min(maxY, offset.y)),
      };
    },
    []
  );

  const resetVideoTransform = useCallback(() => {
    setVideoScale(1);
    setVideoOffset({ x: 0, y: 0 });
  }, []);

  const clearHideTimer = useCallback(() => {
    if (hideControlsTimer.current) {
      clearTimeout(hideControlsTimer.current);
      hideControlsTimer.current = null;
    }
  }, []);

  const startHideTimer = useCallback(() => {
    clearHideTimer();
    if (!isPlayingRef.current) return;

    hideControlsTimer.current = setTimeout(() => {
      if (isPlayingRef.current) {
        setShowControls(false);
      }
    }, 3000);
  }, [clearHideTimer]);

  const [longPressRate, setLongPressRate] = useState(2.0);
  const [isBoosting, setIsBoosting] = useState(false);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const longPressRateRef = useRef(longPressRate);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    longPressRateRef.current = longPressRate;
  }, [longPressRate]);

  useEffect(() => {
    if (!showControls && showSpeedMenu) {
      setShowSpeedMenu(false);
    }
  }, [showControls, showSpeedMenu]);

  useEffect(() => {
    Brightness.getBrightnessAsync()
      .then((value) => {
        if (typeof value === 'number') {
          brightnessRef.current = Math.min(1, Math.max(0.05, value));
        }
      })
      .catch((error) => {
        console.warn('Unable to read screen brightness:', error);
      });
    return () => {
      if (adjustHideTimerRef.current) {
        clearTimeout(adjustHideTimerRef.current);
      }
    };
  }, []);

  const showAdjustIndicator = useCallback(
    (side: 'brightness' | 'volume', value: number) => {
      setAdjustIndicator({ side, value });
      if (adjustHideTimerRef.current) {
        clearTimeout(adjustHideTimerRef.current);
      }
      adjustHideTimerRef.current = setTimeout(() => {
        adjustHideTimerRef.current = null;
        setAdjustIndicator(null);
      }, 800);
    },
    []
  );

  const applyBrightness = useCallback(
    (value: number) => {
      const clamped = Math.min(1, Math.max(0.05, value));
      brightnessRef.current = clamped;
      showAdjustIndicator('brightness', clamped);
      Brightness.setBrightnessAsync(clamped).catch((error) => {
        console.warn('Unable to set screen brightness:', error);
      });
    },
    [showAdjustIndicator]
  );

  const applyVolume = useCallback(
    (value: number) => {
      const clamped = Math.min(1, Math.max(0, value));
      volumeRef.current = clamped;
      setVolumeLevel(clamped);
      showAdjustIndicator('volume', clamped);
      if (clamped === 0 && !isMutedRef.current) {
        setIsMuted(true);
      } else if (clamped > 0 && isMutedRef.current) {
        setIsMuted(false);
      }
    },
    [showAdjustIndicator]
  );

  const handleSelectRate = useCallback(
    (rate: number) => {
      setPlaybackRate(rate);
      setShowSpeedMenu(false);
      startHideTimer();
    },
    [startHideTimer]
  );

  const handleSelectLongPressRate = useCallback((rate: number) => {
    setLongPressRate(rate);
    setShowSpeedMenu(false);
  }, []);

  // Anime4K 增强档位：读取/持久化
  useEffect(() => {
    AsyncStorage.getItem('player.enhancement')
      .then((value) => {
        if (value === 'low' || value === 'medium' || value === 'high' || value === 'off') {
          setEnhancement(value);
        }
      })
      .catch((error) => {
        console.warn('Unable to read enhancement level:', error);
      });
  }, []);

  useEffect(() => {
    AsyncStorage.setItem('player.enhancement', enhancement).catch((error) => {
      console.warn('Unable to persist enhancement level:', error);
    });
  }, [enhancement]);

  const handleCycleEnhancement = useCallback(() => {
    setEnhancement((previous) => {
      const index = ENHANCEMENT_LEVELS.findIndex((item) => item.value === previous);
      return ENHANCEMENT_LEVELS[(index + 1) % ENHANCEMENT_LEVELS.length].value;
    });
    startHideTimer();
  }, [startHideTimer]);

  const handleTogglePlayerOrientation = useCallback(() => {
    setIsPlayerLandscape((previous) => !previous);
    resetVideoTransform();
    startHideTimer();
  }, [resetVideoTransform, startHideTimer]);

  const handleCycleScaleMode = useCallback(() => {
    setScaleModeIndex((prev) => (prev + 1) % SCALE_MODE_OPTIONS.length);
    resetVideoTransform();
    startHideTimer();
  }, [resetVideoTransform, startHideTimer]);

  const toggleControls = useCallback(() => {
    setShowControls((prev) => {
      const next = !prev;
      if (next) {
        startHideTimer();
      }
      return next;
    });
  }, [startHideTimer]);

  const handleVideoPress = useCallback(() => {
    const now = Date.now();
    if (now - lastTapAtRef.current <= DOUBLE_TAP_INTERVAL_MS) {
      lastTapAtRef.current = 0;
      if (tapTimerRef.current) {
        clearTimeout(tapTimerRef.current);
        tapTimerRef.current = null;
      }
      resetVideoTransform();
      return;
    }
    lastTapAtRef.current = now;
    tapTimerRef.current = setTimeout(() => {
      tapTimerRef.current = null;
      toggleControls();
    }, DOUBLE_TAP_INTERVAL_MS);
  }, [resetVideoTransform, toggleControls]);

  useEffect(
    () => () => {
      if (tapTimerRef.current) {
        clearTimeout(tapTimerRef.current);
      }
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
    },
    []
  );

  const cancelLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const stopBoost = useCallback(() => {
    const gesture = gestureRef.current;
    if (!gesture.longPressActive) return;
    gesture.longPressActive = false;
    setIsBoosting(false);
  }, []);

  const videoGestureResponder = useMemo(() => {
    // eslint-disable-next-line react-hooks/refs
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        const { touches } = evt.nativeEvent;
        const gesture = gestureRef.current;
        gesture.activeTouches = touches.length;
        gesture.moved = false;
        gesture.longPressActive = false;
        gesture.startOffset = videoTransformRef.current.offset;
        if (touches.length >= 2) {
          gesture.startDistance = touchDistance(touches[0], touches[1]);
          gesture.startScale = videoTransformRef.current.scale;
          gesture.startCentroid = centroidOf(touches);
        } else {
          gesture.startDistance = 0;
          gesture.startPage = { x: evt.nativeEvent.pageX, y: evt.nativeEvent.pageY };
          longPressTimerRef.current = setTimeout(() => {
            longPressTimerRef.current = null;
            if (gesture.moved || gesture.activeTouches !== 1) return;
            gesture.longPressActive = true;
            setIsBoosting(true);
          }, LONG_PRESS_DURATION_MS);
        }
      },
      onPanResponderMove: (evt) => {
        const { touches } = evt.nativeEvent;
        const gesture = gestureRef.current;
        if (touches.length >= 2) {
          cancelLongPressTimer();
          stopBoost();
          if (gesture.startDistance === 0) {
            gesture.startDistance = touchDistance(touches[0], touches[1]);
            gesture.startScale = videoTransformRef.current.scale;
            gesture.startCentroid = centroidOf(touches);
            gesture.startOffset = videoTransformRef.current.offset;
          }
          gesture.moved = true;
          const nextScale = Math.max(
            MIN_VIDEO_SCALE,
            Math.min(
              MAX_VIDEO_SCALE,
              (gesture.startScale * touchDistance(touches[0], touches[1])) /
                gesture.startDistance
            )
          );
          const currentCentroid = centroidOf(touches);
          const nextOffset = clampVideoOffset(
            {
              x: gesture.startOffset.x + (currentCentroid.x - gesture.startCentroid.x),
              y: gesture.startOffset.y + (currentCentroid.y - gesture.startCentroid.y),
            },
            nextScale
          );
          setVideoScale(nextScale);
          setVideoOffset(nextOffset);
        } else if (touches.length === 1) {
          const dx = evt.nativeEvent.pageX - gesture.startPage.x;
          const dy = evt.nativeEvent.pageY - gesture.startPage.y;
          if (
            !gesture.moved &&
            !gesture.longPressActive &&
            Math.hypot(dx, dy) > TAP_SLOP_PX
          ) {
            gesture.moved = true;
            cancelLongPressTimer();
            if (
              videoTransformRef.current.scale <= 1 &&
              Math.abs(dy) > Math.abs(dx) * 0.8
            ) {
              gesture.adjustSide =
                evt.nativeEvent.pageX < containerSizeRef.current.width / 2
                  ? 'brightness'
                  : 'volume';
              gesture.startBrightness = brightnessRef.current;
              gesture.startVolume = volumeRef.current;
            }
          }
          const currentScale = videoTransformRef.current.scale;
          if (currentScale > 1 && !gesture.longPressActive) {
            setVideoOffset(
              clampVideoOffset(
                { x: gesture.startOffset.x + dx, y: gesture.startOffset.y + dy },
                currentScale
              )
            );
          } else if (gesture.adjustSide !== 'none') {
            const travelRange = containerSizeRef.current.height || 400;
            const progress = -dy / travelRange;
            if (gesture.adjustSide === 'brightness') {
              applyBrightness(gesture.startBrightness + progress * BRIGHTNESS_SENSITIVITY);
            } else {
              applyVolume(gesture.startVolume + progress * VOLUME_SENSITIVITY);
            }
          }
        }
      },
      onPanResponderRelease: () => {
        const gesture = gestureRef.current;
        cancelLongPressTimer();
        gesture.adjustSide = 'none';
        if (gesture.longPressActive) {
          stopBoost();
        } else if (!gesture.moved && gesture.activeTouches === 1) {
          handleVideoPress();
        }
        gesture.moved = false;
        gesture.startDistance = 0;
      },
      onPanResponderTerminate: () => {
        const gesture = gestureRef.current;
        cancelLongPressTimer();
        stopBoost();
        gesture.adjustSide = 'none';
        gesture.moved = false;
        gesture.startDistance = 0;
      },
    });
  }, [
    applyBrightness,
    applyVolume,
    cancelLongPressTimer,
    clampVideoOffset,
    handleVideoPress,
    stopBoost,
  ]);

  useEffect(() => {
    if (isPlaying) {
      startHideTimer();
    } else {
      clearHideTimer();
      setShowControls(true);
    }
  }, [clearHideTimer, isPlaying, startHideTimer]);

  useEffect(() => clearHideTimer, [clearHideTimer]);

  useEffect(() => {
    setStatusBarHidden(true, 'none');

    if (Platform.OS === 'android') {
      const enterImmersiveMode = async () => {
        try {
          await NavigationBar.setBehaviorAsync('overlay-swipe');
        } catch (error) {
          console.warn('Unable to configure immersive navigation:', error);
        }

        try {
          await NavigationBar.setVisibilityAsync('hidden');
        } catch (error) {
          console.warn('Unable to hide Android navigation bar:', error);
        }
      };

      void enterImmersiveMode();
    }

    return () => {
      setStatusBarHidden(false, 'none');
      if (Platform.OS === 'android') {
        void NavigationBar.setVisibilityAsync('visible').catch((error) => {
          console.warn('Unable to restore Android navigation bar:', error);
        });
      }
    };
  }, []);

  const handlePlayPause = useCallback(() => {
    setIsPlaying((previous) => !previous);
  }, []);

  const performSeek = useCallback(
    (positionMs: number) => {
      const clamped = duration > 0 ? Math.max(0, Math.min(positionMs, duration)) : Math.max(0, positionMs);
      videoRef.current?.seek(clamped);
      setCurrentTime(clamped);
      startHideTimer();
    },
    [duration, startHideTimer]
  );

  const handleSeek = useCallback(
    (value: number) => {
      if (duration > 0 && progressBarWidth > 0) {
        const clampedValue = Math.max(0, Math.min(100, value));
        const seekPosition = (clampedValue / 100) * duration;
        performSeek(seekPosition);
      }
    },
    [duration, performSeek, progressBarWidth]
  );

  const handleSkip = useCallback(
    (seconds: number) => {
      if (duration > 0) {
        performSeek(Math.min(currentTime + seconds * 1000, duration));
      }
    },
    [currentTime, duration, performSeek]
  );

  const handleMuteToggle = useCallback(() => {
    setIsMuted((previous) => !previous);
    startHideTimer();
  }, [startHideTimer]);

  const handleToggleSpeedMenu = useCallback(() => {
    setShowSpeedMenu((prev) => !prev);
    startHideTimer();
  }, [startHideTimer]);

  const handleGoBack = useCallback(() => {
    router.back();
  }, [router]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  // Custom slider using PanResponder.
  const panResponder = useMemo(
    () => {
      // The responder reads the video ref only when a touch event fires.
      // eslint-disable-next-line react-hooks/refs
      return PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
          // locationX 是相对进度条的局部坐标（x0/moveX 是屏幕绝对坐标，不能直接用）
          const localX = evt.nativeEvent.locationX;
          if (progressBarWidth > 0) {
            handleSeek((localX / progressBarWidth) * 100);
          }
        },
        onPanResponderMove: (evt) => {
          if (progressBarWidth > 0) {
            handleSeek((evt.nativeEvent.locationX / progressBarWidth) * 100);
          }
        },
      });
    },
    [handleSeek, progressBarWidth]
  );

  const onProgressBarLayout = useCallback((e: LayoutChangeEvent) => {
    setProgressBarWidth(e.nativeEvent.layout.width);
  }, []);

  const hasVideoUri = typeof uri === 'string' && uri.trim().length > 0;
  const rotatedVideoFrame =
    isPlayerLandscape && containerSize.width > 0 && containerSize.height > 0
      ? {
          width: containerSize.height,
          height: containerSize.width,
          left: (containerSize.width - containerSize.height) / 2,
          top: (containerSize.height - containerSize.width) / 2,
        }
      : undefined;

  if (!hasVideoUri) {
    return (
      <Screen
        backgroundColor="#000000"
        statusBarStyle="light"
        safeAreaEdges={['top', 'left', 'right', 'bottom']}
      >
        <View style={styles.errorContainer}>
          <FontAwesome6 name="circle-exclamation" size={40} color="#FCA5A5" />
          <Text style={styles.errorTitle}>无法打开视频</Text>
          <Text style={styles.errorMessage}>视频地址无效或已失效。</Text>
          <TouchableOpacity style={styles.errorBackButton} onPress={handleGoBack}>
            <Text style={styles.errorBackButtonText}>返回列表</Text>
          </TouchableOpacity>
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      backgroundColor="#000000"
      statusBarStyle="light"
      safeAreaEdges={[]}
    >
      <View
        style={styles.videoContainer}
        onLayout={(event) => {
          setContainerSize({
            width: event.nativeEvent.layout.width,
            height: event.nativeEvent.layout.height,
          });
        }}
        {...videoGestureResponder.panHandlers}
      >
        <AppVideo
          ref={videoRef}
          source={uri}
          style={[
            styles.video,
            isPlayerLandscape && styles.videoLandscape,
            rotatedVideoFrame,
            {
              transform: [
                { translateX: videoOffset.x },
                { translateY: videoOffset.y },
                { scale: videoScale },
                ...(isPlayerLandscape ? [{ rotate: '90deg' }] : []),
              ],
            },
          ]}
          paused={!isPlaying}
          rate={isBoosting ? longPressRate : playbackRate}
          volume={volumeLevel}
          muted={isMuted}
          resizeMode={scaleMode}
          enhancement={enhancement}
          onLoad={({ durationMs }) => {
            setPlaybackError(null);
            if (durationMs > 0) {
              setDuration(durationMs);
            }
          }}
          onProgress={({ positionMs }) => {
            setCurrentTime(positionMs);
          }}
          onPlayingChange={({ playing }) => {
            setIsPlaying(playing);
          }}
          onEnded={() => {
            setIsPlaying(false);
            setShowControls(true);
          }}
          onDimensions={({ width, height }) => {
            setVideoDimensions({ width, height });
          }}
          onError={(payload) => {
            setIsPlaying(false);
            const detail = payload?.message ? `（${payload.message}）` : '';
            setPlaybackError(`此视频无法播放，可能是文件已删除或格式不受支持。${detail}`);
          }}
          onFallback={(reason) => {
            setEngineFallbackReason(reason ?? '未知原因');
          }}
        />

        {playbackError && (
          <View style={styles.playbackErrorOverlay} pointerEvents="none">
            <Text style={styles.playbackErrorText}>{playbackError}</Text>
          </View>
        )}

        {engineFallbackReason && (
          <View style={styles.fallbackBadge} pointerEvents="none">
            <Text style={styles.fallbackBadgeText} numberOfLines={2}>
              兼容模式播放（无增强）· mpv：{engineFallbackReason}
            </Text>
          </View>
        )}

        {isBoosting && (
          <View style={styles.boostIndicator} pointerEvents="none">
            <Text style={styles.boostIndicatorText}>{longPressRate}x 倍速中</Text>
          </View>
        )}

        {adjustIndicator && (
          <View
            style={[
              styles.adjustIndicator,
              adjustIndicator.side === 'volume' && styles.adjustIndicatorRight,
            ]}
            pointerEvents="none"
          >
            <FontAwesome6
              name={adjustIndicator.side === 'brightness' ? 'sun' : 'volume-high'}
              size={14}
              color="#FFFFFF"
            />
            <Text style={styles.adjustIndicatorText}>
              {Math.round(adjustIndicator.value * 100)}%
            </Text>
            <View style={styles.adjustIndicatorTrack}>
              <View
                style={[
                  styles.adjustIndicatorFill,
                  { height: `${Math.min(100, Math.max(0, adjustIndicator.value * 100))}%` },
                ]}
              />
            </View>
          </View>
        )}

        {/* Top overlay */}
        {showControls && (
          <View
            style={[
              styles.topOverlay,
              {
                paddingTop: isAndroid
                  ? 16
                  : Math.max(insets.top + 12, Platform.OS === 'web' ? 20 : 48),
                paddingLeft: isAndroid ? 16 : Math.max(insets.left + 12, 16),
                paddingRight: isAndroid ? 16 : Math.max(insets.right + 12, 16),
              },
            ]}
          >
            <TouchableOpacity style={styles.backButton} onPress={handleGoBack}>
              <FontAwesome6 name="chevron-left" size={20} color="#FFFFFF" />
            </TouchableOpacity>
            <Text style={styles.videoTitle} numberOfLines={1}>
              {title || 'Video'}
            </Text>
            {videoDimensions && (
              <View style={styles.resolutionBadge}>
                <Text style={styles.resolutionText}>
                  {getQualityLabel(videoDimensions.width, videoDimensions.height)}
                </Text>
              </View>
            )}
            <View style={styles.topRight}>
              {isMpvSupported && (
                <TouchableOpacity
                  style={styles.scaleModeButton}
                  onPress={handleCycleEnhancement}
                >
                  <FontAwesome6 name="wand-magic-sparkles" size={11} color="#FFFFFF" />
                  <Text style={styles.scaleModeText}>
                    {ENHANCEMENT_LEVELS.find((item) => item.value === enhancement)?.label ??
                      '原生'}
                  </Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={styles.scaleModeButton}
                onPress={handleCycleScaleMode}
              >
                <FontAwesome6
                  name="arrows-up-down-left-right"
                  size={11}
                  color="#FFFFFF"
                />
                <Text style={styles.scaleModeText}>
                  {SCALE_MODE_OPTIONS[scaleModeIndex].label}
                </Text>
              </TouchableOpacity>
              {(videoScale !== 1 || videoOffset.x !== 0 || videoOffset.y !== 0) && (
                <TouchableOpacity
                  style={styles.controlButton}
                  onPress={resetVideoTransform}
                >
                  <FontAwesome6 name="arrows-rotate" size={14} color="#FFFFFF" />
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        {/* Center play button */}
        {showControls && !isPlaying && (
          <TouchableOpacity style={styles.centerPlayButton} onPress={handlePlayPause}>
            <View style={styles.centerPlayCircle}>
              <FontAwesome6 name="play" size={32} color="#FFFFFF" />
            </View>
          </TouchableOpacity>
        )}

        {/* Bottom controls */}
        {showControls && (
          <View
            style={[
              styles.bottomOverlay,
              {
                paddingBottom: isAndroid
                  ? 16
                  : Math.max(insets.bottom + 12, Platform.OS === 'web' ? 16 : 24),
                paddingLeft: isAndroid ? 16 : Math.max(insets.left + 12, 16),
                paddingRight: isAndroid ? 16 : Math.max(insets.right + 12, 16),
              },
            ]}
          >
            {/* Progress bar */}
            <View style={styles.progressContainer}>
              <Text style={styles.timeText}>{formatDuration(currentTime)}</Text>
              <View
                style={styles.progressBarContainer}
                onLayout={onProgressBarLayout}
                {...panResponder.panHandlers}
              >
                <View style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      { width: `${Math.min(progress, 100)}%` },
                    ]}
                  />
                </View>
                <View
                  style={[
                    styles.progressThumb,
                    { left: `${Math.min(progress, 100)}%` },
                  ]}
                />
              </View>
              <Text style={styles.timeText}>{formatDuration(duration)}</Text>
            </View>

            {/* Control buttons */}
            <View style={styles.controlsRow}>
              <TouchableOpacity
                style={styles.controlIconButton}
                onPress={handleMuteToggle}
              >
                <FontAwesome6
                  name={isMuted ? 'volume-xmark' : 'volume-high'}
                  size={18}
                  color="#FFFFFF"
                />
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.controlIconButton}
                onPress={() => handleSkip(-10)}
              >
                <FontAwesome6 name="backward" size={20} color="#FFFFFF" />
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.playPauseButton}
                onPress={handlePlayPause}
              >
                <FontAwesome6
                  name={isPlaying ? 'pause' : 'play'}
                  size={24}
                  color="#FFFFFF"
                />
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.controlIconButton}
                onPress={() => handleSkip(10)}
              >
                <FontAwesome6 name="forward" size={20} color="#FFFFFF" />
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.speedButton}
                onPress={handleToggleSpeedMenu}
              >
                <Text style={styles.speedText}>{playbackRate}x</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.orientationButton}
                onPress={handleTogglePlayerOrientation}
                accessibilityRole="button"
                accessibilityLabel={
                  isPlayerLandscape ? '切换播放器为竖屏' : '切换播放器为横屏'
                }
              >
                <FontAwesome6
                  name={isPlayerLandscape ? 'arrows-up-down' : 'arrows-left-right'}
                  size={15}
                  color="#FFFFFF"
                />
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Speed menu */}
        {showSpeedMenu && showControls && (
          <>
            <TouchableOpacity
              style={styles.speedMenuBackdrop}
              activeOpacity={1}
              onPress={() => setShowSpeedMenu(false)}
            />
            <View style={styles.speedMenuPanel}>
              <Text style={styles.speedMenuSection}>播放倍速</Text>
              <View style={styles.speedMenuRow}>
                {playbackRates.map((rate) => {
                  const active = playbackRate === rate;
                  return (
                    <TouchableOpacity
                      key={rate}
                      style={[styles.speedMenuItem, active && styles.speedMenuItemActive]}
                      onPress={() => handleSelectRate(rate)}
                    >
                      <Text
                        style={[styles.speedMenuText, active && styles.speedMenuTextActive]}
                      >
                        {rate}x
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <View style={styles.speedMenuDivider} />

              <Text style={styles.speedMenuSection}>长按倍速</Text>
              <View style={styles.speedMenuRow}>
                {LONG_PRESS_RATE_OPTIONS.map((rate) => {
                  const active = longPressRate === rate;
                  return (
                    <TouchableOpacity
                      key={rate}
                      style={[styles.speedMenuItem, active && styles.speedMenuItemActive]}
                      onPress={() => handleSelectLongPressRate(rate)}
                    >
                      <Text
                        style={[styles.speedMenuText, active && styles.speedMenuTextActive]}
                      >
                        {rate}x
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          </>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  videoContainer: {
    flex: 1,
    backgroundColor: '#000000',
    position: 'relative',
    overflow: 'hidden',
  },
  video: {
    flex: 1,
  },
  videoLandscape: {
    position: 'absolute',
    flex: 0,
  },
  topOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: Platform.OS === 'web' ? 20 : 48,
    paddingHorizontal: 16,
    paddingBottom: 16,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  backButton: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  videoTitle: {
    flex: 1,
    color: '#F1F5F9',
    fontSize: 16,
    fontWeight: '600',
    marginHorizontal: 12,
  },
  resolutionBadge: {
    backgroundColor: '#6366F1',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
  },
  resolutionText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
  },
  topRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  scaleModeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 30,
    paddingHorizontal: 10,
    borderRadius: 15,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  scaleModeText: {
    color: '#F1F5F9',
    fontSize: 12,
    fontWeight: '600',
  },
  boostIndicator: {
    position: 'absolute',
    top: '30%',
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(99,102,241,0.6)',
  },
  boostIndicatorText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  adjustIndicator: {
    position: 'absolute',
    left: 24,
    top: '30%',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 20,
    paddingVertical: 12,
    paddingHorizontal: 10,
    gap: 8,
    width: 52,
  },
  adjustIndicatorRight: {
    left: undefined,
    right: 24,
  },
  adjustIndicatorText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  adjustIndicatorTrack: {
    width: 6,
    height: 90,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.25)',
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  adjustIndicatorFill: {
    width: '100%',
    backgroundColor: '#6366F1',
  },
  speedMenuBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  speedMenuPanel: {
    position: 'absolute',
    bottom: 130,
    alignSelf: 'center',
    width: 280,
    borderRadius: 16,
    backgroundColor: 'rgba(22,22,30,0.97)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    paddingVertical: 14,
    paddingHorizontal: 14,
  },
  speedMenuSection: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 8,
  },
  speedMenuRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  speedMenuItem: {
    minWidth: 56,
    height: 34,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  speedMenuItemActive: {
    backgroundColor: '#6366F1',
  },
  speedMenuText: {
    color: '#CBD5E1',
    fontSize: 13,
    fontWeight: '600',
  },
  speedMenuTextActive: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  speedMenuDivider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
    marginVertical: 12,
  },
  controlButton: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  centerPlayButton: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: [{ translateX: -36 }, { translateY: -36 }],
  },
  centerPlayCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(99, 102, 241, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  bottomOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: Platform.OS === 'web' ? 16 : 24,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingTop: 16,
  },
  progressContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  timeText: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
    minWidth: 44,
    textAlign: 'center',
  },
  progressBarContainer: {
    flex: 1,
    marginHorizontal: 8,
    height: 28,
    justifyContent: 'center',
  },
  progressTrack: {
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: 4,
    backgroundColor: '#6366F1',
    borderRadius: 2,
  },
  progressThumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#FFFFFF',
    top: 7,
    marginLeft: -7,
  },
  controlsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 4,
  },
  controlIconButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  playPauseButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(99, 102, 241, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  speedButton: {
    minWidth: 44,
    height: 32,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  orientationButton: {
    width: 36,
    height: 32,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  speedText: {
    color: '#F1F5F9',
    fontSize: 12,
    fontWeight: '700',
  },
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  errorTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    marginTop: 16,
  },
  errorMessage: {
    color: '#94A3B8',
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
  },
  errorBackButton: {
    backgroundColor: '#4F46E5',
    borderRadius: 8,
    marginTop: 24,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  errorBackButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  playbackErrorOverlay: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    padding: 24,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  playbackErrorText: {
    color: '#FFFFFF',
    fontSize: 14,
    textAlign: 'center',
  },
  fallbackBadge: {
    alignSelf: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderRadius: 8,
    bottom: 96,
    maxWidth: '86%',
    paddingHorizontal: 10,
    paddingVertical: 6,
    position: 'absolute',
  },
  fallbackBadgeText: {
    color: '#FFD54F',
    fontSize: 12,
    textAlign: 'center',
  },
});
