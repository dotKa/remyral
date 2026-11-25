-- p19-ide W2b (docs/design/p19-ide.md "Implementation (W2b)"): Tam IDE on macOS and Windows machines (code-server).
-- The master's VSIX cache may now hold the platform builds those machines need — `darwin-x64`, `darwin-arm64` and
-- `win32-x64` — next to `universal` and the Linux ones (0190).
--
-- Additive. Rollback: an older master never writes the new values; to restore the 0190 check, delete the rows with
-- the new targets first (DELETE FROM ide_extension_blobs WHERE target_platform IN ('darwin-x64', 'darwin-arm64',
-- 'win32-x64')), then re-add the 0190 constraint.

ALTER TABLE ide_extension_blobs DROP CONSTRAINT ide_extension_blobs_target_platform_check;
ALTER TABLE ide_extension_blobs ADD CONSTRAINT ide_extension_blobs_target_platform_check CHECK (
  target_platform IN (
    'universal',
    'linux-x64',
    'linux-arm64',
    'linux-armhf',
    'darwin-x64',
    'darwin-arm64',
    'win32-x64'
  )
);
