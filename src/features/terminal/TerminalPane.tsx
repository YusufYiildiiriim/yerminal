import { useEffect, useRef } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

type TerminalOutput = { sessionId: string; data: string };
type ShellKind = "powershell" | "bash" | "zsh";
type TerminalPaneProps = { sessionId: string; shell: ShellKind; active: boolean; onExit: (sessionId: string) => void };

export function TerminalPane({ sessionId, shell, active, onExit }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

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
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    terminalRef.current = terminal;
    fitRef.current = fit;

    let disposed = false;
    let outputUnlisten: (() => void) | undefined;
    let exitUnlisten: (() => void) | undefined;

    const initialize = async () => {
      if (!isTauri()) {
        terminal.writeln("Desktop runtime required. Launch this workspace with npm run tauri dev.");
        terminal.writeln("Rust and Cargo must be installed to start the Tauri application.");
        return;
      }
      outputUnlisten = await listen<TerminalOutput>("terminal-output", ({ payload }) => {
        if (payload.sessionId === sessionId) terminal.write(payload.data);
      });
      if (disposed) {
        outputUnlisten();
        return;
      }
      exitUnlisten = await listen<string>("terminal-exited", ({ payload }) => {
        if (payload === sessionId) {
          terminal.writeln("\r\n[process exited]");
          onExit(sessionId);
        }
      });
      if (disposed) {
        outputUnlisten();
        exitUnlisten();
        return;
      }
      try {
        await invoke("create_terminal", {
          sessionId,
          shell,
          workingDirectory: null,
          cols: Math.max(2, terminal.cols),
          rows: Math.max(2, terminal.rows),
        });
      } catch (error) {
        terminal.writeln(`\r\n[terminal start error: ${String(error)}]`);
        onExit(sessionId);
        return;
      }
      terminal.onData((data) => {
        void invoke("write_terminal", { sessionId, data }).catch((error: unknown) => {
          terminal.writeln(`\r\n[terminal input error: ${String(error)}]`);
        });
      });
      fit.fit();
      void invoke("resize_terminal", { sessionId, cols: terminal.cols, rows: terminal.rows });
    };
    void initialize().catch((error: unknown) => {
      terminal.writeln(`\r\n[terminal initialization error: ${String(error)}]`);
    });

    const resizeObserver = new ResizeObserver(() => {
      if (!activeRef.current || disposed) return;
      fit.fit();
      void invoke("resize_terminal", { sessionId, cols: terminal.cols, rows: terminal.rows });
    });
    resizeObserver.observe(hostRef.current);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      outputUnlisten?.();
      exitUnlisten?.();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, shell, onExit]);

  useEffect(() => {
    if (!active || !terminalRef.current || !fitRef.current) return;
    requestAnimationFrame(() => {
      fitRef.current?.fit();
      const terminal = terminalRef.current;
      if (terminal && isTauri()) {
        void invoke("resize_terminal", { sessionId, cols: terminal.cols, rows: terminal.rows });
        terminal.focus();
      }
    });
  }, [active, sessionId]);

  return <div className="terminal-instance" ref={hostRef} aria-label={`Terminal ${sessionId}`} hidden={!active} />;
}

export default TerminalPane;



