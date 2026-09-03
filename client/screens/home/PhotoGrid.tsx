/**
 * 图片网格（双指捏合调列数）
 *
 * 从 home/index.tsx 的图片 FlatList + renderPhotoCard 拆出。
 * 列数状态由页面层 usePhotoGridColumns 提供（搜索栏的网格选择器共享同一状态）。
 */
import React, { useCallback } from 'react';
import { FlatList, Image, TouchableOpacity } from 'react-native';
import { GestureDetector, type GestureType } from 'react-native-gesture-handler';
import { GRID_GAP, screenWidth, PhotoItem } from './shared';
import { createStyles } from './styles';

type Styles = ReturnType<typeof createStyles>;

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
        />
      </TouchableOpacity>
    ),
    [onPressPhoto, photoCardWidth, styles]
  );

  return (
    <GestureDetector gesture={photoPinch}>
      <FlatList
        key={`photo-grid-${photoColumns}`}
        data={photos}
        keyExtractor={(item) => item.id}
        renderItem={renderPhotoCard}
        numColumns={photoColumns}
        contentContainerStyle={styles.photoList}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={12}
        maxToRenderPerBatch={16}
        windowSize={7}
      />
    </GestureDetector>
  );
}
