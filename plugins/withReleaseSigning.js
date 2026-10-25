/**
 * Expo 配置插件：release 构建用私有签名密钥签名（android/ 由 prebuild 生成，不手改）。
 *
 * 签名配置文件默认在 <项目>/.secrets/release-signing.properties（已在 .gitignore 中排除），
 * 也可用环境变量 ROUTE_SIGNING_PROPERTIES 指定。内容：
 *   storeFile=…/route-release.jks
 *   storePassword=…
 *   keyAlias=route-release
 *   keyPassword=…
 *   certSha1=…            （证书 SHA-1，公开信息，App 请求 Google 时用）
 * 找不到这个文件时退回调试签名，并在 Gradle 输出里警告。
 */
const { withAppBuildGradle } = require('expo/config-plugins');

const MARK = '// route-release-signing';

const LOADER = `
${MARK}
def routeSigningFile = file(System.getenv('ROUTE_SIGNING_PROPERTIES') ?: '../../.secrets/release-signing.properties')
def routeSigningProps = new Properties()
if (routeSigningFile.exists()) {
    routeSigningFile.withInputStream { routeSigningProps.load(it) }
} else {
    logger.warn("Route: \${routeSigningFile} not found - release build will use the DEBUG keystore")
}
`;

const RELEASE_CONFIG = `
        release {
            if (routeSigningFile.exists()) {
                storeFile file(routeSigningProps['storeFile'])
                storePassword routeSigningProps['storePassword']
                keyAlias routeSigningProps['keyAlias']
                keyPassword routeSigningProps['keyPassword']
            }
        }`;

function apply(src) {
  if (src.includes(MARK)) return src;
  let out = src.replace(/\nandroid\s*\{/, `${LOADER}\nandroid {`);
  out = out.replace(/(signingConfigs\s*\{\s*\n\s*debug\s*\{[\s\S]*?\n\s*\})/, `$1${RELEASE_CONFIG}`);
  // 只改 buildTypes 里的 release（signingConfigs 里也有一个 release，debug 构建类型保持调试签名）
  const bt = out.indexOf('buildTypes {');
  const rel = bt >= 0 ? out.indexOf('release {', bt) : -1;
  const sc = rel >= 0 ? out.indexOf('signingConfig signingConfigs.debug', rel) : -1;
  if (sc >= 0) {
    out =
      out.slice(0, sc) +
      'signingConfig routeSigningFile.exists() ? signingConfigs.release : signingConfigs.debug' +
      out.slice(sc + 'signingConfig signingConfigs.debug'.length);
  }
  if (!out.includes(MARK) || !out.includes('signingConfigs.release')) {
    throw new Error('withReleaseSigning: android/app/build.gradle 结构和预期不同，请检查插件');
  }
  return out;
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (c) => {
    c.modResults.contents = apply(c.modResults.contents);
    return c;
  });
};
module.exports.apply = apply;
