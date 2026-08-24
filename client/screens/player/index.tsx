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
import { Video, ResizeMode } from 'expo-av';
import type { default as VideoType } from 'expo-av/build/Video';
import { FontAwesome6 } from '@expo/vector-icons';
import { Screen } from '@/components/Screen';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import { formatDuration } from '@/utils/format';

export default function PlayerScreen() {
  const router = useSafeRouter();
  const { uri, title, duration: durationParam } = useSafeSearchParams<{
    uri: string;
    title: string;
    duration: number;
  }>();

  const videoRef = useRef<VideoType>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(durationParam ? durationParam * 1000 : 0);
  const [isFullscreen] = useState(true);
  const [showControls, setShowControls] = useState(true);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const hideControlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressBarWidth = useRef(0);

  const playbackRates = useMemo(() => [0.5, 0.75, 1.0, 1.25, 1.5, 2.0], []);

  const startHideTimer = useCallback(() => {
    if (hideControlsTimer.current) {
      clearTimeout(hideControlsTimer.current);
    }
    hideControlsTimer.current = setTimeout(() => {
      setShowControls((prev) => {
        // Only hide if playing
        if (isPlaying) return false;
        return prev;
      });
    }, 3000);
  }, [isPlaying]);

  const handleTap = useCallback(() => {
    setShowControls((prev) => {
      const next = !prev;
      if (next) {
        // If showing controls, start the hide timer
        if (hideControlsTimer.current) {
          clearTimeout(hideControlsTimer.current);
        }
        hideControlsTimer.current = setTimeout(() => {
          setShowControls((p) => {
            if (isPlaying) return false;
            return p;
          });
        }, 3000);
      }
      return next;
    });
  }, [isPlaying]);

  useEffect(() => {
    // Initial show with timer
    startHideTimer();
    return () => {
      if (hideControlsTimer.current) {
        clearTimeout(hideControlsTimer.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePlayPause = useCallback(async () => {
    if (videoRef.current) {
      if (isPlaying) {
        await videoRef.current.pauseAsync();
      } else {
        await videoRef.current.playAsync();
      }
      setIsPlaying(!isPlaying);
      startHideTimer();
    }
  }, [isPlaying, startHideTimer]);

  const handleSeek = useCallback(
    async (value: number) => {
      if (videoRef.current && duration > 0 && progressBarWidth.current > 0) {
        const clampedValue = Math.max(0, Math.min(100, value));
        const seekPosition = (clampedValue / 100) * duration;
        await videoRef.current.setPositionAsync(seekPosition);
        setCurrentTime(seekPosition);
        startHideTimer();
      }
    },
    [duration, startHideTimer]
  );

  const handleSkip = useCallback(
    async (seconds: number) => {
      if (videoRef.current) {
        const status = await videoRef.current.getStatusAsync();
        if ('positionMillis' in status) {
          const newPosition = Math.max(
            0,
            Math.min(status.positionMillis + seconds * 1000, duration)
          );
          await videoRef.current.setPositionAsync(newPosition);
          setCurrentTime(newPosition);
          startHideTimer();
        }
      }
    },
    [duration, startHideTimer]
  );

  const handleMuteToggle = useCallback(async () => {
    if (videoRef.current) {
      await videoRef.current.setIsMutedAsync(!isMuted);
      setIsMuted(!isMuted);
      startHideTimer();
    }
  }, [isMuted, startHideTimer]);

  const handleCycleSpeed = useCallback(async () => {
    const currentIndex = playbackRates.indexOf(playbackRate);
    const nextIndex = (currentIndex + 1) % playbackRates.length;
    const newRate = playbackRates[nextIndex];
    if (videoRef.current) {
      await videoRef.current.setRateAsync(newRate, true);
      setPlaybackRate(newRate);
      startHideTimer();
    }
  }, [playbackRate, playbackRates, startHideTimer]);

  const handleToggleFullscreen = useCallback(async () => {
    if (videoRef.current) {
      await videoRef.current.presentFullscreenPlayer();
    }
  }, []);

  const handleGoBack = useCallback(() => {
    router.back();
  }, [router]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  // Custom slider using PanResponder
  // 用 ref 持有最新的 handleSeek，避免 PanResponder 只创建一次导致闭包过期
  const seekRef = useRef(handleSeek);
  useEffect(() => {
    seekRef.current = handleSeek;
  }, [handleSeek]);
  const dragStartX = useRef(0);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        // locationX 是相对进度条的局部坐标（x0/moveX 是屏幕绝对坐标，不能直接用）
        const localX = evt.nativeEvent.locationX;
        dragStartX.current = typeof localX === 'number' && !Number.isNaN(localX) ? localX : 0;
        if (progressBarWidth.current > 0) {
          seekRef.current((dragStartX.current / progressBarWidth.current) * 100);
        }
      },
      onPanResponderMove: (_evt, gestureState) => {
        if (progressBarWidth.current > 0) {
          const x = dragStartX.current + (gestureState.moveX - gestureState.x0);
          seekRef.current((x / progressBarWidth.current) * 100);
        }
      },
    })
  ).current;

  const onProgressBarLayout = useCallback((e: LayoutChangeEvent) => {
    progressBarWidth.current = e.nativeEvent.layout.width;
  }, []);

  return (
    <Screen
      backgroundColor="#000000"
      statusBarStyle="light"
      safeAreaEdges={isFullscreen ? [] : ['left', 'right']}
    >
      <TouchableOpacity
        style={styles.videoContainer}
        activeOpacity={1}
        onPress={handleTap}
      >
        <Video
          ref={videoRef}
          source={{ uri: uri as string }}
          style={styles.video}
          resizeMode={ResizeMode.CONTAIN}
          shouldPlay
          isLooping={false}
          onError={(e) => console.error('Video error:', e)}
          onPlaybackStatusUpdate={(status) => {
            if ('isPlaying' in status) {
              setIsPlaying(status.isPlaying);
              if ('durationMillis' in status && status.durationMillis) {
                setDuration(status.durationMillis);
              }
              if ('positionMillis' in status) {
                setCurrentTime(status.positionMillis as number);
              }
            }
          }}
        />

        {/* Top overlay */}
        {showControls && (
          <View style={styles.topOverlay}>
            <TouchableOpacity style={styles.backButton} onPress={handleGoBack}>
              <FontAwesome6 name="chevron-left" size={20} color="#FFFFFF" />
            </TouchableOpacity>
            <Text style={styles.videoTitle} numberOfLines={1}>
              {title || 'Video'}
            </Text>
            <View style={styles.topRight}>
              <TouchableOpacity
                style={styles.controlButton}
                onPress={handleToggleFullscreen}
              >
                <FontAwesome6 name="expand" size={16} color="#FFFFFF" />
              </TouchableOpacity>
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
          <View style={styles.bottomOverlay}>
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
                onPress={handleCycleSpeed}
              >
                <Text style={styles.speedText}>{playbackRate}x</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </TouchableOpacity>
    </Screen>
  );
}

const styles = StyleSheet.create({
  videoContainer: {
    flex: 1,
    backgroundColor: '#000000',
    position: 'relative',
  },
  video: {
    flex: 1,
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
  topRight: {
    flexDirection: 'row',
    alignItems: 'center',
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
    gap: 20,
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
  speedText: {
    color: '#F1F5F9',
    fontSize: 12,
    fontWeight: '700',
  },
});
