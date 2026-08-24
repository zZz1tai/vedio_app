import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, type StyleProp, type ImageStyle } from 'react-native';
import * as VideoThumbnails from 'expo-video-thumbnails';

const thumbnailCache = new Map<string, string>();

interface VideoThumbnailProps {
  uri: string;
  style?: StyleProp<ImageStyle>;
}

export function VideoThumbnail({ uri, style }: VideoThumbnailProps) {
  const [loadedUri, setLoadedUri] = useState(uri);
  const [thumbnailUri, setThumbnailUri] = useState<string | null>(
    () => thumbnailCache.get(uri) ?? null
  );

  if (loadedUri !== uri) {
    setLoadedUri(uri);
    setThumbnailUri(thumbnailCache.get(uri) ?? null);
  }

  useEffect(() => {
    if (thumbnailCache.has(uri)) return;

    let cancelled = false;

    VideoThumbnails.getThumbnailAsync(uri, { time: 1000, quality: 0.6 })
      .then((result) => {
        if (cancelled || !result?.uri) return;
        thumbnailCache.set(uri, result.uri);
        setThumbnailUri(result.uri);
      })
      .catch((error) => {
        console.warn('Failed to load video thumbnail:', error);
      });

    return () => {
      cancelled = true;
    };
  }, [uri]);

  if (!thumbnailUri) {
    return null;
  }

  return (
    <Image
      source={{ uri: thumbnailUri }}
      style={[styles.thumbnail, style]}
      resizeMode="cover"
    />
  );
}

const styles = StyleSheet.create({
  thumbnail: {
    ...StyleSheet.absoluteFillObject,
  },
});
