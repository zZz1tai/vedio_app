import { Platform } from 'react-native';
import { requireNativeModule } from 'expo-modules-core';

export type VideoAiStage =
  | 'queued'
  | 'preparing'
  | 'interpolating'
  | 'upscaling'
  | 'muxing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface VideoAiRequest {
  inputUri: string;
  displayName?: string;
  scale?: 1 | 2;
  interpolation?: 'off' | 'x2';
  preset?: 'balanced' | 'quality';
}

export interface VideoAiJob {
  id: string;
  inputUri: string;
  displayName: string;
  scale: 1 | 2;
  interpolation: 'off' | 'x2';
  preset: 'balanced' | 'quality';
  stage: VideoAiStage;
  progress: number;
  processedFrames: number;
  totalFrames: number;
  outputUri?: string;
  outputWidth?: number;
  outputHeight?: number;
  outputFps?: number;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ImageUpscaleResult {
  outputUri: string;
  width: number;
  height: number;
}

export interface ImageUpscaleRequest {
  inputUri: string;
  scale?: 2 | 4;
}

interface NativeVideoAiModule {
  isAvailable(): boolean;
  enqueue(request: VideoAiRequest): Promise<VideoAiJob>;
  getJob(id: string): Promise<VideoAiJob | null>;
  listJobs(): Promise<VideoAiJob[]>;
  cancel(id: string): Promise<VideoAiJob | null>;
  upscaleImage(request: ImageUpscaleRequest): Promise<ImageUpscaleResult>;
}

let nativeModule: NativeVideoAiModule | null = null;

if (Platform.OS === 'android') {
  try {
    nativeModule = requireNativeModule('ExpoVideoAi') as NativeVideoAiModule;
  } catch {
    nativeModule = null;
  }
}

export const isVideoAiSupported = (): boolean => {
  try {
    return nativeModule?.isAvailable() ?? false;
  } catch {
    return false;
  }
};

export const enqueueVideoAiExport = async (request: VideoAiRequest): Promise<VideoAiJob> => {
  if (nativeModule == null) {
    throw new Error('离线 AI 导出仅支持 Android 真机。');
  }
  return nativeModule.enqueue(request);
};

export const getVideoAiJob = async (id: string): Promise<VideoAiJob | null> => {
  if (nativeModule == null) return null;
  return nativeModule.getJob(id);
};

export const listVideoAiJobs = async (): Promise<VideoAiJob[]> => {
  if (nativeModule == null) return [];
  return nativeModule.listJobs();
};

export const cancelVideoAiJob = async (id: string): Promise<VideoAiJob | null> => {
  if (nativeModule == null) return null;
  return nativeModule.cancel(id);
};

/**
 * 图片 AI 超分：输入图片 uri（content:// 或 file://），
 * 用 Real-ESRGAN x4v3 降噪模型放大到 2x/4x，结果保存到相册（Pictures/夜映/AI）。
 */
export const upscaleImage = async (
  request: ImageUpscaleRequest
): Promise<ImageUpscaleResult> => {
  if (nativeModule == null) {
    throw new Error('离线 AI 超分仅支持 Android 真机。');
  }
  return nativeModule.upscaleImage({
    inputUri: request.inputUri,
    scale: request.scale ?? 4,
  });
};
