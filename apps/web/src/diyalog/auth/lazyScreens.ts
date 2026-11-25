import { lazyScreen } from '../../lib/lazyScreen';

/** p14-web-perf: the Diyalog sign-in steps load on demand (a signed-in visit never needs them). */
export const DyLoginScreen = lazyScreen(() => import('./screens'), 'DyLoginScreen');
export const DyTotpScreen = lazyScreen(() => import('./screens'), 'DyTotpScreen');
export const DyRecoveryLoginScreen = lazyScreen(() => import('./screens'), 'DyRecoveryLoginScreen');
export const DyEnrollScreen = lazyScreen(() => import('./screens'), 'DyEnrollScreen');
export const DyRecoveryCodesScreen = lazyScreen(() => import('./screens'), 'DyRecoveryCodesScreen');
export const DyPasswordChangeScreen = lazyScreen(() => import('./screens'), 'DyPasswordChangeScreen');
export const DySetupScreen = lazyScreen(() => import('./setup'), 'DySetupScreen');
