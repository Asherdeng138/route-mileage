import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { apply } = require('../plugins/withReleaseSigning.js') as { apply: (src: string) => string };

/** Expo SDK 58 模板 android/app/build.gradle 的相关片段 */
const TEMPLATE = `
android {
    ndkVersion rootProject.ext.ndkVersion
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}
`;

test('release builds use the private key, debug builds keep the debug key', () => {
  const out = apply(TEMPLATE);
  const buildTypes = out.slice(out.indexOf('buildTypes {'));
  assert.match(buildTypes, /debug \{\s*signingConfig signingConfigs\.debug/);
  assert.match(buildTypes, /release \{[\s\S]*signingConfig routeSigningFile\.exists\(\) \? signingConfigs\.release : signingConfigs\.debug/);
  assert.match(out, /signingConfigs \{[\s\S]*release \{[\s\S]*storeFile file\(routeSigningProps\['storeFile'\]\)/);
  assert.ok(out.indexOf('def routeSigningFile') < out.indexOf('android {'));
  assert.equal(apply(out), out); // 重复 prebuild 不会重复插入
  assert.throws(() => apply('android { }')); // 模板结构变化时报错，而不是悄悄用调试签名
});
