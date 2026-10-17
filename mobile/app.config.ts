// Per-developer build settings come from the environment, so no personal identifiers live in app.json:
//   NOPEAR_SAAS_URL        default SaaS URL shown on the login screen (users can still edit it there)
//   NOPEAR_IOS_BUNDLE_ID   iOS bundle identifier (must be registrable by your Apple team)
//   NOPEAR_APPLE_TEAM_ID   Apple developer team used for automatic signing
//   NOPEAR_ANDROID_PACKAGE Android application id
// Example: NOPEAR_SAAS_URL=https://nopear.example.com NOPEAR_IOS_BUNDLE_ID=com.you.nopear npx expo run:ios
import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  const env = process.env;
  return {
    ...config,
    name: config.name ?? 'NoPear',
    slug: config.slug ?? 'nopear',
    ios: {
      ...config.ios,
      bundleIdentifier: env.NOPEAR_IOS_BUNDLE_ID || config.ios?.bundleIdentifier,
      ...(env.NOPEAR_APPLE_TEAM_ID ? { appleTeamId: env.NOPEAR_APPLE_TEAM_ID } : {}),
    },
    android: { ...config.android, package: env.NOPEAR_ANDROID_PACKAGE || config.android?.package },
    extra: { ...config.extra, saasUrl: env.NOPEAR_SAAS_URL || config.extra?.saasUrl },
  };
};
