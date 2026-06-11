# Repo Radar Agent Notes

- Package deliverables only into the normal `release/` folder.
- Do not use alternate output folders such as `release-latest/` for handoff builds.
- Do not rename the executable or hand off any differently named build. The deliverable path must remain `release/Repo Radar 1.0.0.exe` unless the user explicitly asks for a version/name change.
- If the normal `release/` build cannot complete because files are locked, stop immediately and ask the user to close Repo Radar or anything holding the release files before trying again.
- Do not work around a locked release build by packaging to another folder, copying from another folder, or changing output names.
