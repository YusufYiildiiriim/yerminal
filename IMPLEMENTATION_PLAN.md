# yerminal Implementation Plan

Source specification: Yusuf's pasted “Rust AI Agent Workspace” brief.

## Phase order
1. Project foundation: Tauri 2, React, TypeScript, strict frontend setup, minimal dark desktop shell.
2. Main layout: compact left developer-tools area with bottom tool tabs, right terminal workspace, resizable divider, toolbar.
3. Terminal core: xterm.js + portable-pty, session management, resize/input/output, cleanup. Implemented; Rust build and interactive PTY verification remain pending.
4. Multiple terminals: focus, close, rename, nested splits and lifecycle-safe visual rearrangement. Source implemented; interactive runtime verification pending.
5. Agent profiles: launch configured CLI commands as ordinary terminal processes. Claude/Codex profile source added; runtime validation pending.
6. Git tools: read-only Changes, lazy diff, incremental Graph, manual refresh. Source implemented; Rust/runtime verification pending.
7. Performance and security review based on measurements and narrow IPC.
8. Validation: formatting, static checks, build, automated and real interactive-terminal checks; report platform limits.

Phases will remain usable after each step. The reference image mentioned by the brief was not included, so the first layout follows its written description.

## Initial risks
- The source directory was empty; no prior design or code can be preserved.
- Rust/Cargo are not installed in the available Windows environment, so Rust build and Tauri runtime validation are currently blocked.
- Windows/Linux/macOS terminal behavior requires platform-specific validation; only Windows is available here.
- GitHub CLI is not installed; private remote setup will use the already authenticated GitHub browser session if available.




