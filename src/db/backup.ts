import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { todayISO } from '@/lib/dates';

import { buildBackup, restoreBackup, validateBackup, type RestoreResult, type ValidatedBackup } from './backupCore';
import { flushWrites, getDb, write } from './core';

async function writeBackupFile(dir: Directory, name: string): Promise<File> {
  await flushWrites();
  const data = await buildBackup(getDb());
  if (!dir.exists) dir.create({ intermediates: true });
  const file = new File(dir, name);
  if (file.exists) file.delete();
  file.create();
  await file.write(JSON.stringify(data));
  return file;
}

/** 导出全部数据为 JSON 并调起分享（可存到 Google Drive / 发邮件） */
export async function exportBackup(): Promise<void> {
  const file = await writeBackupFile(new Directory(Paths.cache, 'backup'), `route-backup-${todayISO()}.json`);
  await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: '保存备份' });
}

/** 恢复前自动保存一份当前数据到 App 私有目录（覆盖恢复出问题时可再导回） */
export async function saveSafetyBackup(): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = await writeBackupFile(new Directory(Paths.document, 'safety-backups'), `before-restore-${stamp}.json`);
  return file.uri;
}

/** 选择备份文件并校验。取消返回 null；校验失败抛出包含原因的错误 */
export async function pickAndValidateBackup(): Promise<ValidatedBackup | null> {
  const picked = await File.pickFileAsync({ mimeTypes: ['application/json', 'text/plain', '*/*'] });
  if (picked.canceled || !picked.result) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await picked.result.text());
  } catch {
    throw new Error('无法读取文件：不是有效的 JSON 备份');
  }
  const v = validateBackup(parsed);
  if (!v.ok) throw new Error(v.errors.join('\n'));
  return v.data;
}

export async function applyBackup(data: ValidatedBackup, mode: 'replace' | 'merge'): Promise<RestoreResult> {
  if (mode === 'replace') await saveSafetyBackup();
  const result = await restoreBackup(data, mode);
  await dropMissingImageFiles();
  return result;
}

const fileExists = (uri: string) => {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
};

/**
 * 备份只含数据，不含图片文件。在新手机 / 重装后恢复时，路线图和附加截图的文件不存在：
 * 清掉这些引用；GPS 行程的路线图标记为「等待生成」，之后自动重新生成。
 */
async function dropMissingImageFiles(): Promise<void> {
  const rows = await getDb().getAllAsync<{ id: number; map_image: string | null; route_map: string | null }>(
    'SELECT id, map_image, route_map FROM trips WHERE map_image IS NOT NULL OR route_map IS NOT NULL',
  );
  const missingShots = rows.filter((r) => r.map_image && !fileExists(r.map_image)).map((r) => r.id);
  const missingMaps = rows.filter((r) => r.route_map && !fileExists(r.route_map)).map((r) => r.id);
  if (!missingShots.length && !missingMaps.length) return;
  await write(async (db) => {
    for (const id of missingShots) {
      await db.runAsync('UPDATE trips SET map_image = NULL, map_image_w = NULL, map_image_h = NULL WHERE id = ?', [id]);
    }
    for (const id of missingMaps) {
      await db.runAsync(`UPDATE trips SET route_map = NULL, route_map_status = 'pending' WHERE id = ?`, [id]);
    }
  });
}
