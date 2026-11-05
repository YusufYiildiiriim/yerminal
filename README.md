# yerminal

Lightweight desktop terminal workspace for developers running multiple AI coding agents.

## Current features

- Tauri 2 desktop shell with a compact dark developer-tools/terminal layout.
- Multiple PTY-backed PowerShell, Bash, or Zsh sessions; tabs, nested splits, rename, resize, close, and keyboard shortcuts.
- Claude Code and Codex CLI agent profiles loaded from the app configuration directory. The first run copies the defaults from `src-tauri/agents.toml`; edit the generated `agents.toml` to change commands or arguments.
- Read-only Git Changes, staged/unstaged diffs, branch/status summary, and incremental commit history.
- xterm scrollback is capped at 3,000 lines; the terminal view is code-split from the initial UI bundle.

Git tools currently accept a repository folder path through the Open a folder field. New terminal/agent sessions use that folder as their initial working directory. Shell sessions can independently change directories afterward.

## Development

Install Node.js and the Rust toolchain required by Tauri 2. Then run:

```sh
npm install
npm run tauri dev
```

Frontend production build:

```sh
npm run build
```

Rust/Tauri builds and interactive terminal behavior have not been validated in the current environment because Rust/Cargo are unavailable. Windows ConPTY behavior, Linux/macOS builds, and CLI agent launches still require runtime validation.

## Notes

- Source implementation plan: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).
- Git operations are read-only; commit, discard, reset, push, and pull are not exposed in the app.
- No Git filesystem watcher is implemented yet; the Changes and Graph views have manual refresh controls.
