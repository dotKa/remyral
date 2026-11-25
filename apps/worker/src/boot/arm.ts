import { installBootGuard } from './guard.js';

// p6-worker-boot-diagnostics: imported FIRST by the entry (src/bin.ts). ES modules evaluate their imports in order,
// so this runs before any other module of the worker bundle: an exception while the rest of the bundle is being
// evaluated, or anywhere before the logger exists, lands in <dataDir>/logs/boot.log.
installBootGuard();
