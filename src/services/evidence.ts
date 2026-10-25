/**
 * 行程路线截图（例如 Google 地图路线截图），导出 Word 时放在行程描述下面，和样板一致。
 * 图片复制到 App 私有目录保存，不上传。
 */
import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

export interface PickedImage {
  uri: string;
  width: number;
  height: number;
}

export async function pickRouteImage(tripId: number): Promise<PickedImage | null> {
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.75, allowsEditing: false });
  if (res.canceled || !res.assets?.length) return null;
  const a = res.assets[0];
  const dir = new Directory(Paths.document, 'route-images');
  if (!dir.exists) dir.create({ intermediates: true });
  const ext = a.mimeType === 'image/png' || /\.png$/i.test(a.uri) ? 'png' : 'jpg';
  const target = new File(dir, `trip-${tripId}-${Date.now()}.${ext}`);
  await new File(a.uri).copy(target);
  return { uri: target.uri, width: a.width, height: a.height };
}

export function deleteRouteImage(uri: string | null) {
  if (!uri) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // 文件已不存在
  }
}
