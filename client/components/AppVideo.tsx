import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { Platform } from 'react-native';
import { ResizeMode, Video } from 'expo-av';
import type { default as VideoType } from 'expo-av/build/Video';
import {
  isMpvSupported,
  MpvVideo,
  type EnhancementLevel,
  type MpvResizeMode,
  type MpvVideoRef,
} from '@/modules/expo-mpv/src';

export type AppResizeMode = MpvResizeMode;

export type { EnhancementLevel };

export interface AppVideoProps {
  source: string;
  paused?: boolean;
  rate?: number;
  volume?: number;
  muted?: boolean;
  resizeMode?: AppResizeMode;
  /** Anime4K 增强档位（仅 Android 生效） */
  enhancement?: EnhancementLevel;
  style?: StyleProp<ViewStyle>;
  onLoad?: (payload: { durationMs: number; width: number; height: number }) => void;
  onProgress?: (payload: { positionMs: number; durationMs: number }) => void;
  onPlayingChange?: (payload: { playing: boolean }) => void;
  onEnded?: () => void;
  onDimensions?: (payload: { width: number; height: number }) => void;
  onError?: (payload?: { message?: string }) => void;
  /** 仅 Android：mpv 初始化/播放失败已回退 expo-av 时回调，reason 为失败原因 */
  onFallback?: (reason?: string) => void;
}

export interface AppVideoRef {
  seek(positionMs: number): void;
}

export const ENHANCEMENT_LEVELS: { value: EnhancementLevel; label: string }[] = [
  { value: 'off', label: '原生' },
  { value: 'low', label: '轻量' },
  { value: 'medium', label: '均衡' },
  { value: 'high', label: '高' },
];

export { isMpvSupported };

const RESIZE_MODE_MAP: Record<AppResizeMode, ResizeMode> = {
  contain: ResizeMode.CONTAIN,
  cover: ResizeMode.COVER,
  stretch: ResizeMode.STRETCH,
};

/**
 * Web / 其他平台：expo-av 回退实现。
 */
const ExpoAvAdapter = forwardRef<AppVideoRef, AppVideoProps>(function ExpoAvAdapter(props, ref) {
  const {
    source,
    paused = false,
    rate = 1,
    volume = 1,
    muted = false,
    resizeMode = 'contain',
    style,
    onLoad,
    onProgress,
    onPlayingChange,
    onEnded,
    onDimensions,
    onError,
  } = props;
  const videoRef = useRef<VideoType | null>(null);
  const loadNotifiedRef = useRef(false);

  useImperativeHandle(
    ref,
    () => ({
      seek(positionMs: number) {
        void videoRef.current?.setPositionAsync(Math.max(0, positionMs));
      },
    }),
    []
  );

  useEffect(() => {
    if (paused) {
      void videoRef.current?.pauseAsync();
    } else {
      void videoRef.current?.playAsync();
    }
  }, [paused]);

  useEffect(() => {
    void videoRef.current?.setRateAsync(rate, true);
  }, [rate]);

  useEffect(() => {
    void videoRef.current?.setIsMutedAsync(muted);
  }, [muted]);

  useEffect(() => {
    if (!muted) {
      void videoRef.current?.setVolumeAsync(volume);
    }
  }, [volume, muted]);

  return (
    <Video
      ref={videoRef}
      source={{ uri: source }}
      style={style}
      resizeMode={RESIZE_MODE_MAP[resizeMode] ?? ResizeMode.CONTAIN}
      shouldPlay={!paused}
      isLooping={false}
      onError={(event) => {
        console.error('Video error:', event);
        onError?.();
      }}
      onPlaybackStatusUpdate={(status) => {
        if (status.isLoaded) {
          onPlayingChange?.({ playing: status.isPlaying });
          onProgress?.({
            positionMs: status.positionMillis ?? 0,
            durationMs: status.durationMillis ?? 0,
          });
          if (!loadNotifiedRef.current && status.durationMillis) {
            loadNotifiedRef.current = true;
            onLoad?.({
              durationMs: status.durationMillis,
              width: 0,
              height: 0,
            });
          }
          const naturalSize = (
            status as { naturalSize?: { width: number; height: number } }
          ).naturalSize;
          if (naturalSize && naturalSize.width > 0) {
            onDimensions?.({ width: naturalSize.width, height: naturalSize.height });
          }
          if (status.didJustFinish) {
            onEnded?.();
          }
        } else if ('error' in status && status.error) {
          onError?.({ message: String(status.error) });
        }
      }}
    />
  );
});

/**
 * Android：libmpv + Anime4K。mpv 初始化或播放失败时自动回退到 expo-av，保证可播。
 */
const MpvAdapter = forwardRef<AppVideoRef, AppVideoProps>(function MpvAdapter(props, ref) {
  const [mpvFailed, setMpvFailed] = useState(false);
  const mpvRef = useRef<MpvVideoRef | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      seek(positionMs: number) {
        mpvRef.current?.seek(positionMs);
      },
    }),
    []
  );

  if (mpvFailed) {
    return <ExpoAvAdapter {...props} />;
  }

  return (
    <MpvVideo
      {...props}
      ref={mpvRef}
      onError={(payload) => {
        console.warn('[AppVideo] mpv error, falling back to expo-av:', payload);
        props.onFallback?.(payload?.message);
        setMpvFailed(true);
      }}
    />
  );
});

export const AppVideo = isMpvSupported ? MpvAdapter : ExpoAvAdapter;
