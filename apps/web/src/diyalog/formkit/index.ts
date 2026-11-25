/**
 * p15-form-pattern (docs/design/p15-form-pattern.md): the one form pattern of the Diyalog screens — tabs, a form per
 * tab with a sticky save bar, the unsaved-changes guard and switches that apply at once.
 */
export {
  DyForm,
  DyFormBar,
  DyFormScope,
  type DyFormApi,
  type DyFormOptions,
  type FieldErrors,
  type FormSection,
  fieldErrorsOf,
  issueText,
  SAVED_TOAST_MS,
  sameValue,
  useCardForm,
  useDyForm,
  useFormScope,
  useFormSection,
  useSectionSave,
} from './form';
export { type GuardEntry, UnsavedGuardProvider, useLeaveGuard, useUnsavedGuard } from './guard';
export { DyInstantToggle } from './instant';
export { DyTabs } from './tabs';
