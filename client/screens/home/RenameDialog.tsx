/**
 * 视频重命名对话框
 *
 * 从 home/index.tsx 的重命名 Modal 拆出，纯受控展示组件。
 */
import React from 'react';
import { Modal, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { ThemePalette } from './shared';
import { createStyles } from './styles';

type Styles = ReturnType<typeof createStyles>;

interface RenameDialogProps {
  visible: boolean;
  renameText: string;
  onRenameTextChange: (text: string) => void;
  renameError: string | null;
  renaming: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onRequestAllFilesAccess: () => void;
  styles: Styles;
  c: ThemePalette;
}

export function RenameDialog({
  visible,
  renameText,
  onRenameTextChange,
  renameError,
  renaming,
  onCancel,
  onConfirm,
  onRequestAllFilesAccess,
  styles,
  c,
}: RenameDialogProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.renamePanel}>
          <Text style={styles.renameTitle}>重命名视频</Text>
          <TextInput
            style={styles.renameInput}
            value={renameText}
            onChangeText={onRenameTextChange}
            placeholder="输入新的文件名"
            placeholderTextColor={c.muted}
            autoCorrect={false}
            autoCapitalize="none"
            selectTextOnFocus
          />
          {!!renameError && (
            <Text style={styles.renameError}>{renameError}</Text>
          )}
          {renameError && (
            <TouchableOpacity
              style={styles.renamePermissionLink}
              onPress={onRequestAllFilesAccess}
            >
              <Text style={styles.renamePermissionText}>
                前往开启「所有文件访问」权限
              </Text>
            </TouchableOpacity>
          )}
          <View style={styles.renameActions}>
            <TouchableOpacity
              style={[styles.renameButton, styles.renameButtonSecondary]}
              onPress={onCancel}
              disabled={renaming}
            >
              <Text style={styles.renameButtonSecondaryText}>取消</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.renameButton, styles.renameButtonPrimary]}
              onPress={onConfirm}
              disabled={renaming}
            >
              <Text style={styles.renameButtonPrimaryText}>
                {renaming ? '保存中...' : '保存'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
