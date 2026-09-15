# 0.1.19 verification — 2026-09-15

## Environment

- Windows build 26200; Edge 152.0.4191.66; Node.js 24.14.0.
- DSH 0.1.5-rc.1 local build; annotation package 0.1.19.
- Installed client SHA-256 matched the local build: `62bca334eed697beed5903055eb9a028563156cdad5402f7b62a196d29d1dd6a`.

## Automated checks

- 22 test files, 154 tests passed, including old/new persistence adapters, independent CRUD for duplicate/contained/overlapping selections, boundary validation, and immutable submitted batches after editing/deleting a sent record.
- TypeScript, ESLint, build, package contract and package-content checks passed.
- Built-component interaction check passed: unified sent tabs, editing/deleting sent records, disabled direct resend, failed-send recovery, retained drafts, outside click and Escape handling.
- Independent static diff review found no blocking issues.

## Actual local DSH checks

- Launcher startup manifest and all declared JavaScript resources loaded successfully.
- Existing sent annotations appeared in the unified tab strip after restart and refresh.
- A fresh test conversation returned a normal model response.
- Dragging the same highlighted words opened the new-annotation menu and saved a second independent record.
- A partially overlapping selection was saved and directly sent. Existing input draft and references remained intact; the model answered successfully.
- The sent record remained in the tab strip, could be edited and saved, and exposed a disabled “已发送” direct-send button.
- Adding the edited sent record to the input produced a new message containing the updated comment; the model answered successfully.
- Deleting that sent record removed its tab while retaining both submitted conversation messages.
- Deleting one of two identical-range records left the other record unchanged. Refresh preserved its comment and original number.

## Installation notes and coverage boundary

The DSH plugin installation command reconciles all installed bundles and can re-enable a bundle previously disabled by the launcher. Reapply the launcher's saved selection before restarting. This was necessary for an unrelated automation plugin on the tested host.

Repacking the same version can reuse the previously installed package. Publish each changed build with a new version and verify installed file hashes before acceptance.

DSH supplies Cordis and storage-domain modules at runtime; the standalone profile's package-manager peer check reports them missing. Actual host loading passed. Old DSH persistence has automated coverage; macOS, Linux, mobile browsers, and a full old-version UI run were not exercised in this release.
