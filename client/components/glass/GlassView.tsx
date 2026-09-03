/**
 * 液态玻璃组件库（零新依赖实现）
 *
 * iOS 26 Liquid Glass 风格的 RN Android 近似实现，不使用 expo-blur /
 * expo-linear-gradient / react-native-svg——这些库虽已在依赖树中但从未被
 * 真实使用，按 expo-image（v1.8.2）的教训，prebuilt 模块首次真实使用
 * 即运行时注册失败的风险不可接受。
 *
 * 实现要点：
 * - GlassView：半透明底色 + 四边独立边框色制造边缘折射高光
 *   （顶部亮边、侧面次亮、底部暗边，RN border 支持逐边颜色）
 * - GlowBackground：洋葱圈柔光光斑（多层同心圆叠加透明度渐变）
 *   + Animated 慢速流动与呼吸，营造液态玻璃的「光环境」
 * - PressableScale：按压弹性缩放（spring 回弹）
 */
import React, { useMemo } from 'react';
import {
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
  type ViewProps,
} from 'react-native';
import { ThemePalette } from '../screens/home/shared';

/** 估算背景明度：判断当前主题明暗，决定玻璃用浅色系还是深色系 */
function isLightBackground(hex: string): boolean {
  const h = (hex || '').replace('#', '');
  if (h.length < 6) return false;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return false;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}

export interface GlassViewProps extends ViewProps {
  palette: ThemePalette;
  /** 圆角，默认 20 */
  radius?: number;
  /** 玻璃浓度：light 轻盈 / standard 常规 / dense 浓稠 */
  intensity?: 'light' | 'standard' | 'dense';
  /** 是否启用顶部高光亮边，默认 true */
  highlight?: boolean;
}

const INTENSITY_MAP = {
  light: { darkAlpha: 0.06, lightAlpha: 0.45 },
  standard: { darkAlpha: 0.1, lightAlpha: 0.62 },
  dense: { darkAlpha: 0.16, lightAlpha: 0.78 },
};

/** 液态玻璃容器：边缘折射高光 + 柔和投影，内容直接放 children */
export function GlassView({
  palette,
  radius = 20,
  intensity = 'standard',
  highlight = true,
  style,
  children,
  ...rest
}: GlassViewProps) {
  const light = useMemo(() => isLightBackground(palette.background), [palette.background]);
  const alpha = INTENSITY_MAP[intensity];

  const glassStyle = useMemo<StyleProp<ViewStyle>>(
    () => ({
      borderRadius: radius,
      overflow: 'hidden',
      backgroundColor: light
        ? `rgba(255, 255, 255, ${alpha.lightAlpha})`
        : `rgba(255, 255, 255, ${alpha.darkAlpha})`,
      borderWidth: 1,
      // 边缘折射：顶部亮边 > 左侧次亮 > 底/右暗边，形成液态玻璃的边缘高光
      borderTopColor: light ? 'rgba(255, 255, 255, 0.95)' : 'rgba(255, 255, 255, 0.3)',
      borderLeftColor: light ? 'rgba(255, 255, 255, 0.75)' : 'rgba(255, 255, 255, 0.16)',
      borderRightColor: light ? 'rgba(255, 255, 255, 0.55)' : 'rgba(255, 255, 255, 0.08)',
      borderBottomColor: light ? 'rgba(255, 255, 255, 0.4)' : 'rgba(255, 255, 255, 0.05)',
      // 柔和浮起
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: light ? 0.08 : 0.22,
      shadowRadius: 16,
      elevation: 5,
    }),
    [light, alpha, radius]
  );

  return (
    <View style={[glassStyle, style]} {...rest}>
      {/* 顶部内高光条：液态玻璃标志性的上边缘反光 */}
      {highlight && (
        <View
          pointerEvents="none"
          style={[
            styles.topHighlight,
            {
              height: radius,
              borderTopLeftRadius: radius,
              borderTopRightRadius: radius,
              backgroundColor: light
                ? 'rgba(255, 255, 255, 0.35)'
                : 'rgba(255, 255, 255, 0.08)',
            },
          ]}
        />
      )}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  topHighlight: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    // 光带只覆盖顶部薄层，下缘自然衰减（靠半透明叠加而非渐变库）
    opacity: 0.5,
  },
});
