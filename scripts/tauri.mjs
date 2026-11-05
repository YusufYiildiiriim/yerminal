import { spawn } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const isWindows = process.platform === "win32";
const command = isWindows ? "powershell.exe" : "tauri";
const commandArgs = isWindows
  ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve("scripts/tauri.ps1"), ...args]
  : args;

const child = spawn(command, commandArgs, { cwd: process.cwd(), stdio: "inherit" });
child.on("error", (error) => {
  console.error(`Unable to start Tauri CLI: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});