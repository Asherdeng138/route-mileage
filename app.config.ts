/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * React Native / Expo 模板自带的调试签名证书 SHA-1（公开证书）。
 * 有私有签名配置（.secrets/release-signing.properties，见 plugins/withReleaseSigning.js）时用私有证书的 SHA-1；
 * 也可用环境变量 ANDROID_CERT_SHA1 指定。
 */
const TEMPLATE_DEBUG_CERT_SHA1 = '5E8F16062EA3CD2C4A0D547876BAA6F38CABF625';

/** 私有签名证书的 SHA-1（公开信息），来自 .secrets/release-signing.properties 的 certSha1 */
function releaseCertSha1(): string | null {
  const file = process.env.ROUTE_SIGNING_PROPERTIES ?? join(__dirname, '.secrets', 'release-signing.properties');
  if (!existsSync(file)) return null;
  const m = /^certSha1=([0-9A-Fa-f:]+)\s*$/m.exec(readFileSync(file, 'utf8'));
  return m ? m[1] : null;
}

/** 本机构建时的 Google Key：.secrets/google-api-key.txt（已 gitignore，不进代码仓库） */
function localGoogleKey(): string {
  const file = join(__dirname, '.secrets', 'google-api-key.txt');
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf8').trim();
}

/**
 * 动态配置：Google API Key 从环境变量（.env 或 EAS 环境变量）或 .secrets/google-api-key.txt 读取，不写进代码。
 * 构建时有 Key：打包进安卓清单，显示 Google 原生地图（Key 需开通 Maps SDK for Android），地点查询也用它。
 * 没有 Key 时 App 仍可正常使用，地图用 OpenStreetMap。
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  // ROUTE_PUBLIC_BUILD=1：公开下载用的安装包，不打包任何 Key（地图用 OpenStreetMap；用户可在 App 里填自己的 Key）
  const publicBuild = process.env.ROUTE_PUBLIC_BUILD === '1';
  const googleMapsApiKey = publicBuild ? '' : process.env.GOOGLE_MAPS_API_KEY || localGoogleKey();
  const plugins = [...(config.plugins ?? [])];
  if (googleMapsApiKey) {
    plugins.push(['react-native-maps', { androidGoogleMapsApiKey: googleMapsApiKey }]);
  }
  return {
    ...config,
    name: config.name ?? '里程记录',
    slug: config.slug ?? 'route-mileage',
    plugins,
    extra: {
      ...config.extra,
      googleMapsApiKey,
      // Google API Key 限制为「Android 应用」时，直接 REST 请求要带上包名和签名证书 SHA-1
      androidPackage: config.android?.package ?? '',
      androidCertSha1: (process.env.ANDROID_CERT_SHA1 ?? releaseCertSha1() ?? TEMPLATE_DEBUG_CERT_SHA1).replace(/:/g, '').toUpperCase(),
    },
  };
};
