/**
 * 柔光流动背景（液态玻璃的「光环境」）
 *
 * 多个彩色光斑以洋葱圈方式叠加（同心圆透明度渐变），
 * 用 Animated 做慢速平移与呼吸缩放，产生 iOS 26 液态玻璃背后的
 * 流动柔光效果。全部使用 RN 基础能力，不引入渐变/模糊库。
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

/** 单个光斑：layers 层同心圆，从中心色逐层放大并减透明度 */
function GlowBlob({
  color,
  size,
  layers = 6,
  opacity = 0.32,
  animatedValue,
  translateRange,
}: {
  color: string;
  size: number;
  layers?: number;
  opacity?: number;
  animatedValue: Animated.Value;
  translateRange: { x: [number, number]; y: [number, number] };
}) {
  const translateX = animatedValue.interpolate({
    inputRange: [0, 1],
    outputRange: [translateRange.x[0], translateRange.x[1]],
  });
  const translateY = animatedValue.interpolate({
    inputRange: [0, 1],
    outputRange: [translateRange.y[0], translateRange.y[1]],
  });
  const scale = animatedValue.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [1, 1.12, 1],
  });

  // 洋葱圈：最外层透明度接近 0，最内层最浓
  const rings = useMemo(() => {
    const arr: { size: number; alpha: number }[] = [];
    for (let i = 0; i < layers; i += 1) {
      const t = i / (layers - 1); // 0 = 最外, 1 = 最内
      arr.push({
        size: size * (1 - t * 0.55),
        alpha: opacity * (0.12 + t * 0.88),
      });
    }
    return arr;
  }, [size, layers, opacity]);

  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFill,
        {
          alignItems: 'center',
          justifyContent: 'center',
          transform: [{ translateX }, { translateY }, { scale }],
        },
      ]}
    >
      {rings.map((ring, index) => (
        <View
          key={index}
          style={{
            position: 'absolute',
            width: ring.size,
            height: ring.size,
            borderRadius: ring.size / 2,
            backgroundColor: color,
            opacity: ring.alpha,
          }}
        />
      ))}
    </Animated.View>
  );
}

function useLoop(duration: number) {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, {
          toValue: 1,
          duration,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(value, {
          toValue: 0,
          duration,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [value, duration]);
  return value;
}

interface GlowBackgroundProps {
  /** 主光斑颜色（一般用主题 accent 与两个邻近色） */
  colors?: [string, string, string];
  /** 光斑整体透明度，默认 0.32 */
  opacity?: number;
}

export function GlowBackground({
  colors = ['#6366F1', '#22D3EE', '#A78BFA'],
  opacity = 0.32,
}: GlowBackgroundProps) {
  const a1 = useLoop(11000);
  const a2 = useLoop(15000);
  const a3 = useLoop(19000);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={{ position: 'absolute', top: -80, left: -60 }}>
        <GlowBlob
          color={colors[0]}
          size={320}
          opacity={opacity}
          animatedValue={a1}
          translateRange={{ x: [0, 40], y: [0, 60] }}
        />
      </View>
      <View style={{ position: 'absolute', top: '38%', right: -100 }}>
        <GlowBlob
          color={colors[1]}
          size={360}
          opacity={opacity * 0.85}
          animatedValue={a2}
          translateRange={{ x: [0, -50], y: [0, 40] }}
        />
      </View>
      <View style={{ position: 'absolute', bottom: -120, left: '24%' }}>
        <GlowBlob
          color={colors[2]}
          size={300}
          opacity={opacity * 0.75}
          animatedValue={a3}
          translateRange={{ x: [0, 30], y: [0, -50] }}
        />
      </View>
    </View>
  );
}
