import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { Platform } from 'react-native';
import { requireNativeModule, requireNativeViewManager } from 'expo-modules-core';

export type EnhancementLevel = 'off' | 'low' | 'medium' | 'high';

export type MpvResizeMode = 'contain' | 'cover' | 'stretch';

export interface MpvVideoProps {
  source: string;
  paused?: boolean;
  rate?: number;
  volume?: number;
  muted?: boolean;
  resizeMode?: MpvResizeMode;
  enhancement?: EnhancementLevel;
  style?: StyleProp<ViewStyle>;
  onLoad?: (payload: { durationMs: number; width: number; height: number }) => void;
  onProgress?: (payload: { positionMs: number; durationMs: number }) => void;
  onPlayingChange?: (payload: { playing: boolean }) => void;
  onEnded?: () => void;
  onDimensions?: (payload: { width: number; height: number }) => void;
  onError?: (payload?: { message?: string }) => void;
}

export interface MpvVideoRef {
  seek(positionMs: number): void;
}

const isMpvSupported = Platform.OS === 'android';

type NativeMpvViewType = React.ComponentType<MpvVideoProps>;

// 仅在 Android 原生环境解析原生视图组件；Web 端短路，不会触发 requireNativeViewManager
const NativeMpvView: NativeMpvViewType | null = isMpvSupported
  ? (requireNativeViewManager('ExpoMpv') as NativeMpvViewType)
  : null;

/**
 * RN 视图事件投递到 JS 时形如 { nativeEvent: payload }（与 expo-av 一致），
 * 这里统一解包；同时兼容直接投递 payload 的形态。
 */
function unwrapEvent<P>(handler: ((payload: P) => void) | undefined) {
  if (!handler) return undefined;
  return (raw: unknown) => {
    const wrapped = raw as { nativeEvent?: P } | null;
    if (wrapped != null && typeof wrapped === 'object' && 'nativeEvent' in wrapped) {
      handler(wrapped.nativeEvent as P);
    } else {
      handler(raw as P);
    }
  };
}

/**
 * Android 专用。调用方需用 isMpvSupported 判断后再渲染。
 * seek 通过模块级函数路由到当前视图（libmpv 进程内单例，同一时刻只有一个视图）。
 */
export const MpvVideo = forwardRef<MpvVideoRef, MpvVideoProps>(function MpvVideo(props, ref) {
  const seekRef = useRef<(positionMs: number) => void>(() => undefined);

  const {
    onLoad,
    onProgress,
    onPlayingChange,
    onEnded,
    onDimensions,
    onError,
    ...restProps
  } = props;

  const handlers = {
    onLoad: unwrapEvent(onLoad),
    onProgress: unwrapEvent(onProgress),
    onPlayingChange: unwrapEvent(onPlayingChange),
    onEnded: unwrapEvent(onEnded),
    onDimensions: unwrapEvent(onDimensions),
    onError: unwrapEvent(onError),
  };

  useImperativeHandle(
    ref,
    () => ({
      seek(positionMs: number) {
        seekRef.current(positionMs);
      },
    }),
    []
  );

  useEffect(() => {
    if (!isMpvSupported) return;
    const moduleFn = requireNativeModule('ExpoMpv');
    seekRef.current = (positionMs: number) => {
      moduleFn.seek(positionMs);
    };
    return () => {
      seekRef.current = () => undefined;
    };
  }, []);

  if (NativeMpvView == null) {
    throw new Error('MpvVideo 仅支持 Android 平台');
  }

  return <NativeMpvView {...restProps} {...(handlers as unknown as MpvVideoProps)} />;
});

export { isMpvSupported };
