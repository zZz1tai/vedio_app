import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import { Screen } from '@/components/Screen';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import {
  cancelVideoAiJob,
  enqueueVideoAiExport,
  getVideoAiJob,
  isVideoAiSupported,
  type VideoAiJob,
  type VideoAiStage,
} from '@/modules/expo-video-ai/src';
import { formatDuration, getQualityLabel } from '@/utils/format';

const STAGE_LABELS: Record<VideoAiStage, string> = {
  queued: '等待开始',
  preparing: '准备模型',
  interpolating: 'AI 插帧',
  upscaling: 'AI 超分',
  muxing: '封装音频',
  completed: '导出完成',
  failed: '导出失败',
  cancelled: '已取消',
};

const isTerminal = (stage: VideoAiStage) =>
  stage === 'completed' || stage === 'failed' || stage === 'cancelled';

export default function AiExportScreen() {
  const router = useSafeRouter();
  const { inputUri, displayName, durationMs, width, height, jobId } = useSafeSearchParams<{
    inputUri?: string;
    displayName?: string;
    durationMs?: number;
    width?: number;
    height?: number;
    jobId?: string;
  }>();
  const [scale, setScale] = useState<1 | 2>(2);
  const [interpolation, setInterpolation] = useState<'off' | 'x2'>('x2');
  const [preset, setPreset] = useState<'balanced' | 'quality'>('balanced');
  const [job, setJob] = useState<VideoAiJob | null>(null);
  const [starting, setStarting] = useState(false);
  const supported = useMemo(() => isVideoAiSupported(), []);

  const loadJob = useCallback(async (id: string) => {
    const next = await getVideoAiJob(id);
    if (next) setJob(next);
  }, []);

  useEffect(() => {
    if (jobId) void loadJob(jobId);
  }, [jobId, loadJob]);

  useEffect(() => {
    if (!job || isTerminal(job.stage)) return;
    const timer = setInterval(() => {
      void loadJob(job.id);
    }, 750);
    return () => clearInterval(timer);
  }, [job, loadJob]);

  const startExport = useCallback(async () => {
    if (!inputUri || starting || (job && !isTerminal(job.stage))) return;
    setStarting(true);
    try {
      const next = await enqueueVideoAiExport({
        inputUri,
        displayName: displayName || 'AI 导出视频',
        scale,
        interpolation,
        preset,
      });
      setJob(next);
    } catch (error) {
      Toast.show({
        type: 'error',
        text1: '无法开始 AI 导出',
        text2: error instanceof Error ? error.message : '请稍后重试',
      });
    } finally {
      setStarting(false);
    }
  }, [displayName, inputUri, interpolation, job, preset, scale, starting]);

  const cancelExport = useCallback(() => {
    if (!job || isTerminal(job.stage)) return;
    Alert.alert('取消 AI 导出', '当前任务会停止并删除未完成文件。', [
      { text: '继续导出', style: 'cancel' },
      {
        text: '取消任务',
        style: 'destructive',
        onPress: () => {
          void cancelVideoAiJob(job.id).then((next) => {
            if (next) setJob(next);
          });
        },
      },
    ]);
  }, [job]);

  const playOutput = useCallback(() => {
    if (!job?.outputUri) return;
    router.replace('/player', {
      uri: job.outputUri,
      title: `${displayName || '视频'} · AI`,
      duration: durationMs ? durationMs / 1000 : 0,
    });
  }, [displayName, durationMs, job?.outputUri, router]);

  const outputSize = useMemo(() => {
    if (!width || !height) return null;
    const multiplier = scale === 2 ? 2 : 1;
    return `${width * multiplier} × ${height * multiplier}`;
  }, [height, scale, width]);

  const running = job != null && !isTerminal(job.stage);
  const complete = job?.stage === 'completed';

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
        <Text style={styles.title} numberOfLines={1}>AI 导出</Text>
        {running ? (
          <TouchableOpacity
            style={styles.iconButton}
            onPress={cancelExport}
            accessibilityLabel="取消导出"
          >
            <FontAwesome6 name="xmark" size={18} color="#FCA5A5" />
          </TouchableOpacity>
        ) : (
          <View style={styles.iconButton} />
        )}
      </View>

      {!supported ? (
        <View style={styles.stateView}>
          <FontAwesome6 name="triangle-exclamation" size={28} color="#FBBF24" />
          <Text style={styles.stateTitle}>当前设备不可用</Text>
          <Text style={styles.stateText}>需要支持 Vulkan 的 arm64 Android 真机。</Text>
        </View>
      ) : !inputUri && !job ? (
        <View style={styles.stateView}>
          <FontAwesome6 name="circle-exclamation" size={28} color="#FCA5A5" />
          <Text style={styles.stateTitle}>无法读取视频</Text>
        </View>
      ) : (
        <View style={styles.content}>
          <View style={styles.sourceRow}>
            <View style={styles.sourceIcon}>
              <FontAwesome6 name="film" size={17} color="#A5B4FC" />
            </View>
            <View style={styles.sourceTextGroup}>
              <Text style={styles.sourceTitle} numberOfLines={1}>{displayName || 'AI 导出视频'}</Text>
              <Text style={styles.sourceMeta} numberOfLines={1}>
                {width && height ? getQualityLabel(width, height) : '视频'}
                {durationMs ? ` · ${formatDuration(durationMs / 1000)}` : ''}
              </Text>
            </View>
          </View>

          {!running && !complete && (
            <View style={styles.settings}>
              <SettingRow label="分辨率">
                <Segmented
                  value={scale === 2 ? 'x2' : 'off'}
                  options={[
                    { value: 'off', label: '原始' },
                    { value: 'x2', label: '2x' },
                  ]}
                  onChange={(value) => setScale(value === 'x2' ? 2 : 1)}
                />
              </SettingRow>
              <SettingRow label="帧率">
                <Segmented
                  value={interpolation}
                  options={[
                    { value: 'off', label: '保持' },
                    { value: 'x2', label: '2x' },
                  ]}
                  onChange={(value) => setInterpolation(value as 'off' | 'x2')}
                />
              </SettingRow>
              <SettingRow label="预设">
                <Segmented
                  value={preset}
                  options={[
                    { value: 'balanced', label: '均衡' },
                    { value: 'quality', label: '高质量' },
                  ]}
                  onChange={(value) => setPreset(value as 'balanced' | 'quality')}
                />
              </SettingRow>
            </View>
          )}

          {outputSize && !job && (
            <Text style={styles.outputHint}>
              输出 {outputSize}{interpolation === 'x2' ? ' · 最高 60fps' : ''}
            </Text>
          )}

          {job && (
            <View style={styles.jobArea}>
              <View style={styles.jobHeader}>
                <Text style={styles.jobStage}>{STAGE_LABELS[job.stage]}</Text>
                <Text style={styles.jobPercent}>{Math.round(job.progress * 100)}%</Text>
              </View>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${Math.round(job.progress * 100)}%` }]} />
              </View>
              {job.totalFrames > 0 && (
                <Text style={styles.frameMeta}>{job.processedFrames} / {job.totalFrames} 帧</Text>
              )}
              {job.errorMessage && <Text style={styles.errorText}>{job.errorMessage}</Text>}
              {complete && job.outputUri && (
                <TouchableOpacity
                  style={styles.playOutputButton}
                  onPress={playOutput}
                  accessibilityLabel="播放导出视频"
                >
                  <FontAwesome6 name="play" size={14} color="#FFFFFF" />
                  <Text style={styles.playOutputText}>播放导出视频</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {!job || isTerminal(job.stage) ? (
            <TouchableOpacity
              style={[styles.startButton, (starting || !inputUri) && styles.startButtonDisabled]}
              onPress={startExport}
              disabled={starting || !inputUri}
            >
              <FontAwesome6 name="wand-magic-sparkles" size={15} color="#FFFFFF" />
              <Text style={styles.startButtonText}>{job?.stage === 'failed' ? '重新导出' : '开始导出'}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      )}
    </Screen>
  );
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.settingRow}>
      <Text style={styles.settingLabel}>{label}</Text>
      {children}
    </View>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            style={[styles.segment, selected && styles.segmentSelected]}
            onPress={() => onChange(option.value)}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
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
    paddingTop: 24,
  },
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 22,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#27272F',
  },
  sourceIcon: {
    width: 40,
    height: 40,
    borderRadius: 6,
    backgroundColor: '#1E1B4B',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  sourceTextGroup: {
    flex: 1,
  },
  sourceTitle: {
    color: '#F1F5F9',
    fontSize: 15,
    fontWeight: '700',
  },
  sourceMeta: {
    color: '#94A3B8',
    fontSize: 12,
    marginTop: 4,
  },
  settings: {
    marginTop: 12,
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
    height: 32,
    padding: 2,
    borderRadius: 6,
    backgroundColor: '#1A1A22',
  },
  segment: {
    minWidth: 58,
    paddingHorizontal: 8,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 4,
  },
  segmentSelected: {
    backgroundColor: '#4F46E5',
  },
  segmentText: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
  },
  segmentTextSelected: {
    color: '#FFFFFF',
  },
  outputHint: {
    color: '#94A3B8',
    fontSize: 12,
    marginTop: 16,
  },
  jobArea: {
    marginTop: 24,
  },
  jobHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  jobStage: {
    color: '#E2E8F0',
    fontSize: 14,
    fontWeight: '700',
  },
  jobPercent: {
    color: '#A5B4FC',
    fontSize: 13,
    fontWeight: '700',
  },
  progressTrack: {
    height: 5,
    backgroundColor: '#262632',
    marginTop: 10,
    overflow: 'hidden',
    borderRadius: 3,
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#6366F1',
    borderRadius: 3,
  },
  frameMeta: {
    color: '#94A3B8',
    fontSize: 12,
    marginTop: 8,
  },
  errorText: {
    color: '#FCA5A5',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 12,
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
    opacity: 0.45,
  },
  startButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  playOutputButton: {
    alignSelf: 'flex-start',
    marginTop: 18,
    height: 38,
    paddingHorizontal: 14,
    borderRadius: 6,
    backgroundColor: '#4F46E5',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  playOutputText: {
    color: '#FFFFFF',
    fontSize: 13,
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
