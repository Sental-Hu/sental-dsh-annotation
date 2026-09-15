# Independent annotations and unified tabs

## Approved behavior

Multiple annotations may target identical, contained, or overlapping text. Each record retains its own identity, content, version, and deletion lifecycle. Selection boundary validation remains in place.

All saved annotations use the existing tab strip, including sent records. Remove the separate history UI. Existing edit, delete, locate, and input-reference actions apply to sent records as well. Editing or deleting a record does not rewrite submitted conversation messages or batch snapshots. Preserve send-state safety and old/new DSH compatibility adapters.

## Implementation plan

- Replace service overlap rejection with boundary validation for creation and anchor updates; cover independent CRUD for duplicate and overlapping records.
- Render the complete ordered display list in the tab strip; remove obsolete history projection and styles; exercise sent-record edit/delete in the shipped component test.
- Update user documentation and package version. Keep Markdown history projection separate from UI presentation.
- Run tests, typecheck, lint, build, package checks, and the built component interaction test.
- Install the package in local DSH, restart, verify boot resources, then exercise overlapping annotations, sent tabs, editing, deletion, refresh persistence, and a basic conversation in a browser.
- Only after successful local validation, commit and push the scoped changes. Record tested versions and environment without including private conversation content or local paths.
