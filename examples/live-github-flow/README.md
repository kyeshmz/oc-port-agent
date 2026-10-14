# Disposable live GitHub App fixture

This private repository is a controlled test, not a production port.

- `main` contains the deliberately incomplete target API at `lib/strip-prefix.js`.
- `upstream` changes only `reference/bom.js` to remove exactly one leading BOM.
- Fixed tests and `lib/target-helpers.js` are outside the agent's editable scope.
- `npm test` initially fails the BOM behavior test and passes the type/helper tests.
- A real App run must create a verified draft PR changing only the allowed target
  implementation plus host-written checkpoint/evidence files. The App never merges.
- After explicit operator review/merge on this disposable repository, the next
  run must activate the checkpoint and avoid a new model call or duplicate PR.

No credentials or App private keys belong in this repository. Creating the
repository alone is not proof that the App installation or hosted flow works.
