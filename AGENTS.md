# Development requirements

This plugin is intended for open-source distribution.

- Keep changes focused, responsibilities clear, errors actionable, and regression tests tied to observable behavior.
- Support different operating systems, paths, browsers, and DSH versions where practical. Prefer capability detection and isolated host adapters. Discover local paths or accept configuration; do not hard-code a developer's environment.
- After each local update, run relevant automated checks, build and install the actual package into local DSH, and exercise plugin loading, changed behavior, and a basic conversation. Push commits or tags and publish packages only after these checks pass.
- Record package and host versions, operating system, browser, actions, and results. Distinguish unit or simulated checks from real UI validation; do not claim untested environments have passed.
- If local DSH validation fails, fix and retest. If blocked, retain changes locally and report the blocker without pushing. Preserve user sessions, configuration, data, and a recoverable previous installation.
- Keep personal paths, credentials, conversation content, and runtime logs out of the repository.
