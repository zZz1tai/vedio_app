/**
 * 图片网格列数管理 Hook
 *
 * 从 home/index.tsx 拆出：列数档位状态、AsyncStorage 持久化、
 * 双指捏合自动切换档位手势。列数需被首页搜索栏的网格选择器共享，故提升到页面层。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DeviceEventEmitter } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  PHOTO_COLUMNS,
  PHOTO_COLUMN_OPTIONS,
  PHOTO_COLUMN_MIN,
  PHOTO_COLUMN_MAX,
  PHOTO_COLUMNS_STORAGE_KEY,
} from '../screens/home/shared';

/** 设置页修改网格列数后广播的事件名 */
export const PHOTO_COLUMNS_CHANGED_EVENT = 'photoGridColumnsChanged';

export function usePhotoGridColumns() {
  const [photoColumns, setPhotoColumnsState] = useState<number>(PHOTO_COLUMNS);
  const photoColumnsRef = useRef(PHOTO_COLUMNS);
  const pinchBaseRef = useRef(PHOTO_COLUMNS);

  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(PHOTO_COLUMNS_STORAGE_KEY)
      .then((raw) => {
        if (!mounted) return;
        const value = Number(raw);
        if (PHOTO_COLUMN_OPTIONS.includes(value as (typeof PHOTO_COLUMN_OPTIONS)[number])) {
          setPhotoColumnsState(value);
          photoColumnsRef.current = value;
        }
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  // 设置页修改列数后即时同步（无需冷启动）
  useEffect(() => {
    const subscription = DeviceEventEmitter.addListener(PHOTO_COLUMNS_CHANGED_EVENT, (cols: number) => {
      if (PHOTO_COLUMN_OPTIONS.includes(cols as (typeof PHOTO_COLUMN_OPTIONS)[number])) {
        setPhotoColumnsState(cols);
        photoColumnsRef.current = cols;
      }
    });
    return () => subscription.remove();
  }, []);

  const applyPhotoColumns = useCallback((cols: number) => {
    setPhotoColumnsState(cols);
    photoColumnsRef.current = cols;
    AsyncStorage.setItem(PHOTO_COLUMNS_STORAGE_KEY, String(cols)).catch(() => undefined);
  }, []);

  /** 双指捏合：放大 -> 列数变少（格子变大）；缩小 -> 列数变多（格子变小） */
  const photoPinch = useMemo(
    () =>
      Gesture.Pinch()
        .runOnJS(true)
        .onStart(() => {
          pinchBaseRef.current = photoColumnsRef.current;
        })
        .onUpdate((event) => {
          const raw = Math.round(pinchBaseRef.current / event.scale);
          const clamped = Math.max(PHOTO_COLUMN_MIN, Math.min(PHOTO_COLUMN_MAX, raw));
          const nearest = PHOTO_COLUMN_OPTIONS.reduce((best, opt) =>
            Math.abs(opt - clamped) < Math.abs(best - clamped) ? opt : best
          );
          if (nearest !== photoColumnsRef.current) {
            setPhotoColumnsState(nearest);
            photoColumnsRef.current = nearest;
          }
        })
        .onEnd(() => {
          AsyncStorage.setItem(PHOTO_COLUMNS_STORAGE_KEY, String(photoColumnsRef.current)).catch(
            () => undefined
          );
        }),
    []
  );

  return { photoColumns, applyPhotoColumns, photoPinch };
}
