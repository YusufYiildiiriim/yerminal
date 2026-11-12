# yerminal

<p align="center">
  <strong>A lightweight desktop terminal workspace for running multiple AI coding agents side by side.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-0078D4?logo=windows11&logoColor=white" alt="Windows and Linux" />
  <img src="https://img.shields.io/badge/built%20with-Tauri%202-FF1313?logo=tauri&logoColor=white" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/frontend-React%2019-61DAFB?logo=react&logoColor=white" alt="React 19" />
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License" />
</p>

yerminal gives every AI coding agent — Claude Code, Codex CLI, or a plain shell — its own PTY-backed terminal session in a single window, next to a file explorer, an editable code view, and Git tooling. Open a folder, split your workspace into as many terminals as you need, and keep the code and the diffs in sight while your agents work.

<!-- TODO: add a screenshot here once published: ![yerminal workspace](docs/screenshot.png) -->

## Features

### Terminal workspace
- **Multiple PTY sessions** — PowerShell, Bash, or Zsh, each in its own pane with tabs, nested splits, and free-form rearrangement via drag & drop
- **Flexible layout** — resize panes from corners or with keyboard shortcuts, close free panes with a middle click, rename anything
- **Resource metrics** — per-workspace CPU and memory usage in a live strip above the sessions
- **Idempotent startup** — sessions survive restarts without spawning duplicates

### AI agent profiles
- Ships with **Claude Code** and **Codex CLI** profiles out of the box
- Add your own agents (command + args) through a simple `agents.toml` file
- Agent sessions open directly in your selected workspace folder

### Git
- Stage, unstage, discard, and commit changes
- Structured diff view with clear added/removed line styling
- Commit history graph with per-commit file inspection and snapshot preview in the editor

### Code view
- Editable code editor with syntax highlighting (Shiki), autosave, and quick file open
- Commit snapshot banner to inspect the state of a file at any commit

### Workspace
- Auto-hiding tool sidebar that collapses to an activity rail
- Appearance and typography presets, refined dark themes
- Keyboard shortcuts menu (`Help → Shortcuts`)

## Getting started

**Prerequisites:** [Node.js](https://nodejs.org) `>=22.22.2`, the Rust toolchain, and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform. Windows builds require the MSVC C++ build tools; MSI packaging also requires the Windows Script Host optional feature. Linux builds require Tauri's WebKitGTK and system library prerequisites.

```sh
npm ci
npm run tauri dev     # run the desktop app in development
npm run build         # production build of the frontend
```

### Build installers locally

Run these from the repository root after installing the platform prerequisites above. The release workflow runs the corresponding commands through Tauri's CLI:

```powershell
# Windows: NSIS setup executable and MSI installer
npm run tauri build -- --bundles nsis,msi
```

```sh
# Linux: AppImage and Debian package
npm run tauri build -- --bundles appimage,deb
```

[Download the latest release](https://github.com/YusufYiildiiriim/yerminal/releases/latest): Windows users can choose the NSIS setup executable (`.exe`) or MSI installer (`.msi`); Linux users can choose the AppImage (`.AppImage`) or Debian package (`.deb`). Installers are also written under `src-tauri/target/release/bundle/` when built locally. The Windows installers are currently unsigned; Windows may display a SmartScreen warning. A stable GitHub release is published for each push to `main`, tagged `v<app-version>-build.<run-number>`. Both platform builds upload to one draft release, which is published only after all builds succeed. If a build fails, rerunning the workflow resumes its draft. Rerunning an already published build starts a separate draft tagged `v<app-version>-build.<run-number>.attempt.<run-attempt>`; failed retries reuse that draft. Later pushes get a new build tag. Linux artifacts are built by CI, but Linux runtime behavior has not yet been verified. macOS builds are not provided.

## Configuration

Agent profiles live in `src-tauri/agents.toml`. On first run the defaults are copied to the app configuration directory — edit the generated file to change commands or arguments, or to add new agents:

```toml
[[agents]]
id = "claude"
name = "Claude Code"
command = "claude"
args = []

[[agents]]
id = "codex"
name = "Codex CLI"
command = "codex"
args = []
```

## Project structure

```
src/                     # React + TypeScript frontend
  features/
    terminal/            # xterm.js panes, floating canvas, resource graph
    editor/              # code workspace, snapshots, quick open
    git/                 # diff viewer
    settings/            # settings dialog
    workspace/           # layout shell
src-tauri/               # Rust backend (Tauri 2)
  src/terminal.rs        # PTY session management
  src/git.rs             # Git operations (libgit2 via git2-rs)
  src/workspace_fs.rs    # workspace file system access
  agents.toml            # default agent profiles
```

## Status & limitations

This is an early MVP — expect rough edges:

- Git push, pull, and reset are not exposed (local operations only)
- Explorer watches for filesystem changes; the Git Changes and Graph views still require manual refresh
- xterm scrollback is capped at 3,000 lines
- Windows is the only verified platform

## Contributing

Issues and pull requests are welcome. If you run yerminal on Linux or macOS, reports on what breaks are especially valuable.

## License

[MIT](LICENSE)
