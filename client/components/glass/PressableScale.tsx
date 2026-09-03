/**
 * 按压弹性缩放（液态玻璃的呼吸感）
 *
 * 按下时缩放到 scaleTo，松开 spring 回弹，
 * 用于卡片 / tab / 按钮等可交互元素的玻璃化按压反馈。
 */
import React, { useCallback, useRef } from 'react';
import { Animated, Pressable, type PressableProps } from 'react-native';

interface PressableScaleProps extends PressableProps {
  scaleTo?: number;
  children: React.ReactNode;
}

export function PressableScale({
  scaleTo = 0.96,
  children,
  onPressIn,
  onPressOut,
  style,
  ...rest
}: PressableScaleProps) {
  const scale = useRef(new Animated.Value(1)).current;

  const handlePressIn = useCallback(
    (e: any) => {
      Animated.spring(scale, {
        toValue: scaleTo,
        useNativeDriver: true,
        friction: 8,
        tension: 220,
      }).start();
      onPressIn?.(e);
    },
    [onPressIn, scale, scaleTo]
  );

  const handlePressOut = useCallback(
    (e: any) => {
      Animated.spring(scale, {
        toValue: 1,
        useNativeDriver: true,
        friction: 5,
        tension: 180,
      }).start();
      onPressOut?.(e);
    },
    [onPressOut, scale]
  );

  return (
    <Pressable onPressIn={handlePressIn} onPressOut={handlePressOut} {...rest}>
      <Animated.View style={[style, { transform: [{ scale }] }]}>
        {children}
      </Animated.View>
    </Pressable>
  );
}
