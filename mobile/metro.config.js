// Expo SDK 57 auto-configures monorepo watchFolders/nodeModulesPaths; we only make sure the workspace
// TS sources (@nopear/core, @nopear/protocol) and their package "exports" subpaths resolve.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
