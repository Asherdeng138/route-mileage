/** 打开 App 时的归档维护：数据库部分见 src/db/archive.ts，这里再删掉永久删除行程的图片文件 */
import { runArchiveMaintenance, type MaintenanceResult } from '@/db/archive';

import { deleteRouteImage } from './evidence';

export async function archiveMaintenanceOnLaunch(now = Date.now()): Promise<MaintenanceResult> {
  const r = await runArchiveMaintenance(now);
  for (const uri of r.files) deleteRouteImage(uri);
  return r;
}
