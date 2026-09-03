/**
 * 图片网格（双指捏合调列数）
 *
 * 从 home/index.tsx 的图片 FlatList + renderPhotoCard 拆出。
 * 列数状态由页面层 usePhotoGridColumns 提供（搜索栏的网格选择器共享同一状态）。
 *
 * 性能设计（v1.9.0）：
 * - 渐进分页渲染：data 只暴露前 visibleCount 张，onEndReached 追加一批。
 *   万级列表一次性挂载全部 cell 配置会让 VirtualizedList 的窗口管理变重，
 *   且深处图片解码队列拥塞表现为「滑到底不加载」；分批后每批只挂 300 张。
 * - resizeMethod="resize"：Android Fresco 解码时降采样到视图尺寸，
 *   避免每张 4-12MB 原图全尺寸解码进内存（卡顿与 OOM 的主因）。
 * - 渲染窗口按列数自适应：列数多时同屏 cell 成倍增加，
 *   initialNumToRender / maxToRenderPerBatch 随列数放大，windowSize 提到 11 防快速滚动空白。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Image, TouchableOpacity } from 'react-native';
import { GestureDetector, type GestureType } from 'react-native-gesture-handler';
import { GRID_GAP, screenWidth, PhotoItem } from './shared';
import { createStyles } from './styles';

type Styles = ReturnType<typeof createStyles>;

const PAGE_SIZE = 300;

interface PhotoGridProps {
  photos: PhotoItem[];
  photoColumns: number;
  photoPinch: GestureType;
  onPressPhoto: (photo: PhotoItem) => void;
  styles: Styles;
}

export function PhotoGrid({
  photos,
  photoColumns,
  photoPinch,
  onPressPhoto,
  styles,
}: PhotoGridProps) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // 数据源变化（重扫完成/搜索过滤/切 tab 后重载）时重置渐进窗口
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [photos]);

  const data = useMemo(
    () => (photos.length > visibleCount ? photos.slice(0, visibleCount) : photos),
    [photos, visibleCount]
  );

  const photoCardWidth = (screenWidth - GRID_GAP * 2) / photoColumns - GRID_GAP;

  const renderPhotoCard = useCallback(
    ({ item }: { item: PhotoItem }) => (
      <TouchableOpacity
        style={[styles.photoCard, { width: photoCardWidth }]}
        activeOpacity={0.7}
        onPress={() => onPressPhoto(item)}
      >
        <Image
          source={{ uri: item.uri }}
          style={styles.photoImage}
          resizeMode="cover"
          resizeMethod="resize"
        />
      </TouchableOpacity>
    ),
    [onPressPhoto, photoCardWidth, styles]
  );

  const onEndReached = useCallback(() => {
    setVisibleCount((prev) => (prev < photos.length ? prev + PAGE_SIZE : prev));
  }, [photos.length]);

  const denseGrid = photoColumns >= 6;

  return (
    <GestureDetector gesture={photoPinch}>
      <FlatList
        key={`photo-grid-${photoColumns}`}
        data={data}
        keyExtractor={(item) => item.id}
        renderItem={renderPhotoCard}
        numColumns={photoColumns}
        contentContainerStyle={styles.photoList}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={denseGrid ? 36 : 18}
        maxToRenderPerBatch={denseGrid ? 36 : 18}
        updateCellsBatchingPeriod={30}
        windowSize={11}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.6}
      />
    </GestureDetector>
  );
}
