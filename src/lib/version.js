import { version } from '../../package.json';

// package.json's `version` is the single source of truth for the app's
// semver number, bumped by hand there on release -- imported directly
// (Vite/Rollup both support importing .json as an ES module out of the
// box) rather than via a vite.config.js `define`, so this file's own
// import graph is all that's needed to resolve it, in dev, in the built
// bundle, and under Vitest alike.
export const APP_VERSION = version;
