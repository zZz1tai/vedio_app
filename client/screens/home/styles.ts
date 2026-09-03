/**
 * 首页样式表（从 home/index.tsx 拆出，纯机械搬运，行为不变）
 * v2.0.0：容器统一液态玻璃化（半透明底 + 四边独立边框色折射高光）
 */
import { StyleSheet } from 'react-native';
import { CARD_WIDTH, GRID_GAP } from './shared';
import type { ThemePalette } from './shared';

/** 估算背景明度：决定玻璃容器用浅色系（亮主题）还是深色系（暗主题） */
function isLightBg(hex: string): boolean {
  const h = (hex || '').replace('#', '');
  if (h.length < 6) return false;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return false;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}

export function createStyles(c: ThemePalette) {
  const light = isLightBg(c.background);

  /** 液态玻璃边框：四边独立色，顶部亮边、侧面次亮、底右暗边（折射感） */
  const glassBorder = {
    borderWidth: 1,
    borderTopColor: light ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.32)',
    borderLeftColor: light ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.16)',
    borderRightColor: light ? 'rgba(255,255,255,0.52)' : 'rgba(255,255,255,0.08)',
    borderBottomColor: light ? 'rgba(255,255,255,0.36)' : 'rgba(255,255,255,0.05)',
  } as const;

  /** 液态玻璃容器：半透明底 + 玻璃边框 */
  const glass = (alpha: number) => ({
    ...glassBorder,
    backgroundColor: light
      ? `rgba(255, 255, 255, ${alpha})`
      : `rgba(255, 255, 255, ${alpha * 0.22})`,
  });

  /** 激活态（accent）容器的顶部高光边 */
  const accentGlass = {
    borderTopColor: 'rgba(255,255,255,0.45)',
    borderLeftColor: 'rgba(255,255,255,0.22)',
  } as const;

  return StyleSheet.create({
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  loadingText: {
    color: c.muted,
    fontSize: 14,
    marginTop: 16,
  },
  permissionIcon: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: c.accentSoft,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  permissionTitle: {
    color: c.foreground,
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 8,
  },
  permissionDesc: {
    color: c.muted,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
  },
  permissionButton: {
    backgroundColor: c.accent,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
  },
  permissionButtonText: {
    color: c.accentForeground,
    fontSize: 15,
    fontWeight: '600',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'web' ? 20 : 12,
    paddingBottom: 16,
  },
  headerLeft: {
    flex: 1,
  },
  headerTitle: {
    color: c.foreground,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    color: c.muted,
    fontSize: 13,
    marginTop: 4,
    fontWeight: '500',
  },
  viewToggle: {
    width: 40,
    height: 40,
    borderRadius: 10,
    ...glass(0.62),
    justifyContent: 'center',
    alignItems: 'center',
  },
  viewToggleActive: {
    backgroundColor: c.accent,
    borderColor: c.accent,
    ...accentGlass,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  homeTabs: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  homeTab: {
    flex: 1,
    height: 38,
    borderRadius: 10,
    ...glass(0.62),
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  homeTabActive: {
    backgroundColor: c.accent,
    borderColor: c.accent,
    ...accentGlass,
  },
  homeTabText: {
    color: c.muted,
    fontSize: 13,
    fontWeight: '600',
  },
  homeTabTextActive: {
    color: c.accentForeground,
  },
  photoList: {
    paddingHorizontal: GRID_GAP,
    paddingBottom: 40,
  },
  photoCard: {
    aspectRatio: 1,
    marginHorizontal: GRID_GAP / 2,
    marginBottom: GRID_GAP,
    backgroundColor: c.backgroundTertiary,
    borderRadius: 10,
    overflow: 'hidden',
    ...glassBorder,
    position: 'relative',
  },
  photoImage: {
    ...StyleSheet.absoluteFillObject,
  },
  groupTabs: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  groupTab: {
    height: 30,
    paddingHorizontal: 14,
    borderRadius: 15,
    ...glass(0.62),
    justifyContent: 'center',
  },
  groupTabActive: {
    backgroundColor: c.accent,
    borderColor: c.accent,
    ...accentGlass,
  },
  groupTabText: {
    color: c.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  groupTabTextActive: {
    color: c.accentForeground,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
  },
  sectionTitle: {
    flex: 1,
    color: c.foreground,
    fontSize: 14,
    fontWeight: '700',
  },
  sectionCount: {
    color: c.muted,
    fontSize: 12,
    fontWeight: '600',
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    overflow: 'hidden',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emptyTitle: {
    color: c.foreground,
    fontSize: 18,
    fontWeight: '600',
    marginTop: 20,
    marginBottom: 8,
  },
  emptyDesc: {
    color: c.muted,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
  },
  // Grid styles
  gridList: {
    paddingHorizontal: GRID_GAP,
    paddingBottom: 40,
  },
  gridRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  gridCard: {
    width: CARD_WIDTH,
    marginHorizontal: GRID_GAP / 2,
    marginBottom: GRID_GAP,
    ...glass(0.62),
    borderRadius: 12,
    overflow: 'hidden',
  },
  gridThumbnail: {
    width: '100%',
    aspectRatio: 16 / 10,
    backgroundColor: c.backgroundTertiary,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  gridDurationBadge: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.75)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  gridDurationText: {
    color: c.foreground,
    fontSize: 11,
    fontWeight: '600',
  },
  gridQualityBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: c.accent,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  gridQualityText: {
    color: c.accentForeground,
    fontSize: 10,
    fontWeight: '700',
  },
  gridInfo: {
    padding: 10,
  },
  gridTitle: {
    color: c.foreground,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  gridMeta: {
    color: c.muted,
    fontSize: 11,
    marginTop: 4,
    fontWeight: '500',
  },
  // List styles
  listList: {
    paddingHorizontal: 16,
    paddingBottom: 40,
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: c.border,
  },
  listThumbnail: {
    width: 72,
    height: 52,
    borderRadius: 8,
    backgroundColor: c.backgroundTertiary,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  listDurationBadge: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    backgroundColor: 'rgba(0,0,0,0.75)',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },
  listDurationText: {
    color: c.foreground,
    fontSize: 9,
    fontWeight: '600',
  },
  listInfo: {
    flex: 1,
  },
  listTitle: {
    color: c.foreground,
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
  },
  listMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: 8,
  },
  qualityBadge: {
    backgroundColor: c.accentSoft,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
  },
  qualityText: {
    color: c.accent,
    fontSize: 10,
    fontWeight: '700',
  },
  metaText: {
    color: c.muted,
    fontSize: 12,
    fontWeight: '500',
  },
  listSeparator: {
    height: 8,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 12,
    height: 40,
    paddingHorizontal: 12,
    ...glass(0.62),
    borderRadius: 10,
  },
  searchInput: {
    flex: 1,
    color: c.foreground,
    fontSize: 14,
    paddingVertical: 0,
  },
  searchClearButton: {
    width: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  gridToggle: {
    width: 26,
    height: 26,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  gridPicker: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingBottom: 12,
    marginTop: -2,
  },
  gridPickerItem: {
    minWidth: 34,
    height: 30,
    paddingHorizontal: 8,
    borderRadius: 15,
    ...glass(0.62),
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridPickerItemActive: {
    backgroundColor: c.accent,
    borderColor: c.accent,
    ...accentGlass,
  },
  gridPickerText: {
    color: c.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  gridPickerTextActive: {
    color: c.accentForeground,
  },
  gridPickerHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 'auto',
  },
  gridPickerHintText: {
    color: c.muted,
    fontSize: 10,
  },
  searchConfirmButton: {
    width: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  searchSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  searchSummaryText: {
    color: c.muted,
    fontSize: 12,
  },
  accessBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: c.dangerSoft,
    borderRadius: 10,
    borderWidth: 1,
    borderTopColor: light ? 'rgba(255,255,255,0.9)' : 'rgba(252,165,165,0.35)',
    borderLeftColor: light ? 'rgba(255,255,255,0.65)' : 'rgba(252,165,165,0.18)',
    borderRightColor: light ? 'rgba(255,255,255,0.5)' : 'rgba(252,165,165,0.1)',
    borderBottomColor: light ? 'rgba(255,255,255,0.35)' : 'rgba(252,165,165,0.06)',
  },
  accessBannerText: {
    flex: 1,
    color: c.danger,
    fontSize: 12,
    lineHeight: 17,
  },
  gridEditButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  listEditButton: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 4,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: 32,
  },
  renamePanel: {
    ...glass(0.78),
    borderRadius: 16,
    padding: 18,
  },
  renameTitle: {
    color: c.foreground,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  renameInput: {
    ...glass(0.45),
    borderRadius: 10,
    color: c.foreground,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  renameError: {
    color: c.danger,
    fontSize: 12,
    marginTop: 8,
  },
  renamePermissionLink: {
    marginTop: 8,
  },
  renamePermissionText: {
    color: c.accent,
    fontSize: 12,
    textDecorationLine: 'underline',
  },
  renameActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 16,
  },
  renameButton: {
    height: 38,
    paddingHorizontal: 16,
    borderRadius: 10,
    justifyContent: 'center',
  },
  renameButtonPrimary: {
    backgroundColor: c.accent,
  },
  renameButtonPrimaryText: {
    color: c.accentForeground,
    fontSize: 14,
    fontWeight: '600',
  },
  renameButtonSecondary: {
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  renameButtonSecondaryText: {
    color: c.foreground,
    fontSize: 14,
  },
});
}
