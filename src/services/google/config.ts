import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

/**
 * Google Maps Platform API Key。两种来源（都不写进代码仓库）：
 *  1. 在 App「设置 → Google 地点」里填写：保存在手机加密存储（expo-secure-store），优先使用；
 *  2. 构建时的 .env：GOOGLE_MAPS_API_KEY=xxx，由 app.config.ts 注入（同时用于原生 Google 地图底图）。
 */
const BUILD_TIME_KEY: string = (Constants.expoConfig?.extra?.googleMapsApiKey as string | undefined) ?? '';
const STORE_KEY = 'google_maps_api_key';

let userKey: string | null = null;
let loaded = false;

export async function loadGoogleKey(): Promise<string> {
  if (!loaded) {
    try {
      userKey = await SecureStore.getItemAsync(STORE_KEY);
    } catch {
      userKey = null;
    }
    loaded = true;
  }
  return userKey || BUILD_TIME_KEY;
}

export async function saveGoogleKey(key: string | null): Promise<void> {
  const k = key?.trim() || null;
  if (k) await SecureStore.setItemAsync(STORE_KEY, k);
  else await SecureStore.deleteItemAsync(STORE_KEY);
  userKey = k;
  loaded = true;
}

/** 已加载的 Key（调用前需要先 await loadGoogleKey()） */
export const currentGoogleKey = () => userKey || BUILD_TIME_KEY;

/** 是否有任何 Key（App 内填写或构建时） */
export const isGoogleConfigured = () => currentGoogleKey().length > 0;

/** 原生 Google 地图底图需要构建时把 Key 写进 AndroidManifest，只有构建时 Key 才能用 */
export const hasBuildTimeMapsKey = () => BUILD_TIME_KEY.length > 0;

/**
 * Key 限制为「Android 应用」时，Google 通过这两个请求头识别是哪个 App 发出的请求。
 * 值来自构建配置（app.config.ts）：包名 + 签名证书 SHA-1。
 */
export function androidIdentityHeaders(): Record<string, string> {
  const extra = Constants.expoConfig?.extra ?? {};
  const pkg = (extra.androidPackage as string | undefined) ?? '';
  const cert = (extra.androidCertSha1 as string | undefined) ?? '';
  return pkg && cert ? { 'X-Android-Package': pkg, 'X-Android-Cert': cert } : {};
}

/** 只显示首尾，便于用户确认填的是哪个 Key */
export function maskKey(k: string): string {
  return k.length <= 10 ? '••••' : `${k.slice(0, 6)}••••${k.slice(-4)}`;
}

export class GoogleNotConfiguredError extends Error {
  constructor() {
    super('还没有配置 Google Maps API Key');
    this.name = 'GoogleNotConfiguredError';
  }
}
