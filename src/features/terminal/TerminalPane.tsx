import { useEffect, useRef } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { registerUrlLinks } from "./terminalLinks";
import "@xterm/xterm/css/xterm.css";

type TerminalOutput = { sessionId: string; sequence: number; data: string };
type TerminalOutputSnapshot = { throughSequence: number; events: TerminalOutput[] };
type ShellKind = "powershell" | "bash" | "zsh";
type TerminalPaneProps = { sessionId: string; shell: ShellKind; profileId?: string; workingDirectory: string | null; active: boolean; visible: boolean; onLinkHint?: (message: string) => void; onFocus: (sessionId: string) => void; onExit: (sessionId: string) => void };

export function TerminalPane({ sessionId, shell, profileId, workingDirectory, active, visible, onLinkHint, onFocus, onExit }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeSyncRef = useRef<() => void>(() => {});
  const activeRef = useRef(active);
  const visibleRef = useRef(visible);
  const onLinkHintRef = useRef(onLinkHint);
  const onFocusRef = useRef(onFocus);
  const onExitRef = useRef(onExit);
  const linkHintShownRef = useRef(false);
  activeRef.current = active;
  visibleRef.current = visible;
  onLinkHintRef.current = onLinkHint;
  onFocusRef.current = onFocus;
  onExitRef.current = onExit;

  useEffect(() => {
    if (!hostRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", Consolas, monospace',
      fontSize: 13,
      scrollback: 3000,
      allowProposedApi: false,
      theme: {
        background: "#101114",
        foreground: "#d7d7dc",
        cursor: "#b2a4ff",
        selectionBackground: "#51487a88",
        black: "#17181c",
        red: "#e07883",
        green: "#83c99b",
        yellow: "#d6b879",
        blue: "#83a9de",
        magenta: "#b89add",
        cyan: "#7fc5c4",
        white: "#d7d7dc",
        brightBlack: "#747780",
        brightRed: "#ef8994",
        brightGreen: "#91d5a8",
        brightYellow: "#e5c98a",
        brightBlue: "#91b7eb",
        brightMagenta: "#c5a9e9",
        brightCyan: "#8ed5d4",
        brightWhite: "#f1f1f4",
      },
    });
    const applyAppearance = () => {
      const host = hostRef.current;
      if (!host) return;
      const style = getComputedStyle(host);
      const value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
      const fontSize = Number.parseFloat(value("--terminal-font-size", "13"));
      terminal.options.fontFamily = value("--terminal-font-family", '"Cascadia Code", Consolas, monospace');
      terminal.options.fontSize = Number.isFinite(fontSize) ? Math.min(32, Math.max(8, fontSize)) : 13;
      terminal.options.theme = {
        ...terminal.options.theme,
        background: value("--theme-terminal", "#101114"),
        foreground: value("--theme-text", "#d7d7dc"),
        cursor: value("--theme-accent", "#b2a4ff"),
      };
    };
    applyAppearance();
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const linkProvider = registerUrlLinks(terminal, {
      open: (url) => {
        if (isTauri()) {
          void openUrl(url).catch((error: unknown) => {
            onLinkHintRef.current?.(`Could not open link: ${String(error)}`);
          });
        } else {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      },
      hint: (message) => {
        if (linkHintShownRef.current) return;
        linkHintShownRef.current = true;
        onLinkHintRef.current?.(message);
      },
    });
    const handleFocus = () => onFocusRef.current(sessionId);
    hostRef.current.addEventListener("focusin", handleFocus);

    let disposed = false;
    let replayingOutput = true;
    const pendingOutput: TerminalOutput[] = [];
    let outputUnlisten: (() => void) | undefined;
    let exitUnlisten: (() => void) | undefined;
    let ptyReady = false;
    let resizeInFlight = false;
    let inFlightPtySizeKey: string | null = null;
    let resizeTimer: number | null = null;
    let lastPtySize: string | null = null;
    let pendingPtySize: { cols: number; rows: number; key: string } | null = null;

    const readTerminalSize = () => {
      const cols = Math.max(2, terminal.cols);
      const rows = Math.max(2, terminal.rows);
      return { cols, rows, key: `${cols}x${rows}` };
    };

    const flushPtyResize = async () => {
      if (disposed || !ptyReady || resizeInFlight || !pendingPtySize) return;
      if (!visibleRef.current) {
        pendingPtySize = null;
        return;
      }
      const size = pendingPtySize;
      pendingPtySize = null;
      if (size.key === lastPtySize) return;
      resizeInFlight = true;
      inFlightPtySizeKey = size.key;
      try {
        await invoke("resize_terminal", { sessionId, cols: size.cols, rows: size.rows });
      } catch (error) {
        console.warn(`Could not resize terminal ${sessionId}:`, error);
      } finally {
        lastPtySize = size.key;
        resizeInFlight = false;
        inFlightPtySizeKey = null;
        if (!disposed && pendingPtySize && resizeTimer === null) {
          resizeTimer = window.setTimeout(() => {
            resizeTimer = null;
            void flushPtyResize();
          }, 90);
        }
      }
    };

    const fitAndSchedulePtyResize = () => {
      if (disposed) return;
      fit.fit();
      if (!visibleRef.current || !ptyReady || !isTauri()) return;
      const size = readTerminalSize();
      if (size.key === (resizeInFlight ? inFlightPtySizeKey : lastPtySize)) {
        pendingPtySize = null;
        if (resizeTimer !== null) window.clearTimeout(resizeTimer);
        resizeTimer = null;
        return;
      }
      if (pendingPtySize?.key === size.key) return;
      pendingPtySize = size;
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        void flushPtyResize();
      }, 90);
    };
    resizeSyncRef.current = fitAndSchedulePtyResize;

    const initialize = async () => {
      if (!isTauri()) {
        terminal.writeln("Desktop runtime required. Launch this workspace with npm run tauri dev.");
        terminal.writeln("Rust and Cargo must be installed to start the Tauri application.");
        return;
      }
      outputUnlisten = await listen<TerminalOutput>("terminal-output", ({ payload }) => {
        if (payload.sessionId !== sessionId) return;
        if (replayingOutput) pendingOutput.push(payload);
        else terminal.write(payload.data);
      });
      if (disposed) {
        outputUnlisten();
        return;
      }
      exitUnlisten = await listen<string>("terminal-exited", ({ payload }) => {
        if (payload === sessionId) {
          terminal.writeln("\r\n[process exited]");
          onExitRef.current(sessionId);
        }
      });
      if (disposed) {
        outputUnlisten();
        exitUnlisten();
        return;
      }
      fit.fit();
      const initialSize = readTerminalSize();
      try {
        if (profileId) {
          await invoke("create_agent_terminal", { sessionId, profileId, workingDirectory, cols: initialSize.cols, rows: initialSize.rows });
        } else {
          await invoke("create_terminal", { sessionId, shell, workingDirectory, cols: initialSize.cols, rows: initialSize.rows });
        }
      } catch (error) {
        terminal.writeln(`\r\n[terminal start error: ${String(error)}]`);
        onExitRef.current(sessionId);
        return;
      }
      if (disposed) return;
      ptyReady = true;
      lastPtySize = initialSize.key;
      fitAndSchedulePtyResize();
      let throughSequence = 0;
      try {
        const snapshot = await invoke<TerminalOutputSnapshot>("terminal_output_snapshot", { sessionId });
        if (disposed) return;
        for (const event of snapshot.events) terminal.write(event.data);
        throughSequence = snapshot.throughSequence;
      } catch (error) {
        console.warn(`Could not restore terminal output for ${sessionId}:`, error);
      }
      for (const event of pendingOutput) {
        if (event.sequence > throughSequence) terminal.write(event.data);
      }
      pendingOutput.length = 0;
      replayingOutput = false;
      terminal.onData((data) => {
        void invoke("write_terminal", { sessionId, data }).catch((error: unknown) => {
          terminal.writeln(`\r\n[terminal input error: ${String(error)}]`);
        });
      });
      fitAndSchedulePtyResize();
    };
    void initialize().catch((error: unknown) => {
      terminal.writeln(`\r\n[terminal initialization error: ${String(error)}]`);
    });

    const resizeObserver = new ResizeObserver(() => {
      if (!visibleRef.current || disposed) return;
      fitAndSchedulePtyResize();
    });
    resizeObserver.observe(hostRef.current);
    const appearanceRoot = hostRef.current.closest(".app-shell");
    const appearanceObserver = new MutationObserver(() => {
      if (disposed) return;
      applyAppearance();
      if (visibleRef.current) fitAndSchedulePtyResize();
    });
    if (appearanceRoot) appearanceObserver.observe(appearanceRoot, { attributes: true, attributeFilter: ["style", "data-theme"] });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      appearanceObserver.disconnect();
      linkProvider.dispose();
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      if (resizeSyncRef.current === fitAndSchedulePtyResize) resizeSyncRef.current = () => {};
      outputUnlisten?.();
      exitUnlisten?.();
      hostRef.current?.removeEventListener("focusin", handleFocus);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, shell, profileId, workingDirectory]);

  useEffect(() => {
    if (!visible || !terminalRef.current || !fitRef.current) return;
    requestAnimationFrame(() => {
      resizeSyncRef.current();
      const terminal = terminalRef.current;
      if (terminal && isTauri() && activeRef.current) {
        terminal.focus();
      }
    });
  }, [active, visible, sessionId]);

  return (
    <div className="terminal-instance" aria-label={`Terminal ${sessionId}`} hidden={!visible}>
      <div className="terminal-fit" ref={hostRef} />
    </div>
  );
}

export default TerminalPane;




