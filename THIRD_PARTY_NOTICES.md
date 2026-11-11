# Third-party code

`vendor/autodl-watch/` is adapted from:

- Project: Stop-Manually-Refreshing-AutoDL-GPU
- Author: cc2025cheng
- Source: https://github.com/cc2025cheng/Stop-Manually-Refreshing-AutoDL-GPU
- Upstream commit: 7f5bee9 (main snapshot retrieved 2026-11-11)
- License: MIT, copyright (c) 2026 cc2025cheng
- Full license: [vendor/autodl-watch/LICENSE](vendor/autodl-watch/LICENSE)

The vendored source, web UI, and tests retain the upstream implementation. Electron integration is in `src/rent-workspace.js` and `src/main.js`. The desktop application binds this engine to a random loopback port and stores runtime state under the current user's application data directory. Upstream statements about live-account testing are not validation of this integrated desktop application.
