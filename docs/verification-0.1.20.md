# 0.1.20 verification — 2026-09-15

## Environment

- Sental DSH Annotation 0.1.20; Sental DSH Preflight 0.1.0.
- Windows build 26200; Edge 152.0.4191.66 in headless mode; Node.js 24.14.0.
- DSH 0.1.5-rc.1 local build (183f08e).

## Automated checks

- 22 test files and 154 tests passed.
- TypeScript, ESLint, build, package-contract and package-content checks passed.
- Built-component interaction checks passed.
- Package metadata, Cordis insertion and browser module registration use the new package name.
- Existing storage, HTTP and reference identifiers remain compatible with earlier releases.

## Local installation and actual browser checks

- Backed up the previous package and profile configuration before replacing the old package.
- Installed the new tarball with the DSH plugin command. Installed browser bundle SHA-256 matched the local build.
- Restored the existing plugin selection. Preflight independently loaded the new plugin and verified all 57 startup resources.
- Clicked the launch button in the actual preflight page. Selected-combination verification and formal DSH startup passed.
- An existing conversation displayed its previously saved annotation.
- Created a fresh conversation and received a normal response from the configured model.
- Selected response text, opened the annotation editor and saved a new annotation.
- Reloaded the page and verified that the saved annotation remained available.

These checks cover the stated Windows, Edge and DSH build. Other platforms were not exercised for this rename.
