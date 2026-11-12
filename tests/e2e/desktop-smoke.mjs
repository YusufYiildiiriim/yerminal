import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const appPath = process.env.YERMINAL_E2E_APP ?? path.join(repoRoot, "src-tauri", "target", "release", "yerminal.exe");
const cargoBin = path.join(os.homedir(), ".cargo", "bin");
const tauriDriver = process.env.TAURI_DRIVER ?? path.join(cargoBin, "tauri-driver.exe");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "yerminal-e2e-"));
const profileRoot = await mkdtemp(path.join(os.tmpdir(), "yerminal-webview2-"));
const nestedPath = path.join(tempRoot, "nested");
const resultFile = path.join(nestedPath, "e2e-created.txt");
const marker = `YERMINAL_E2E_${Date.now()}`;
let driverProcess;
let sessionId;
let driverBaseUrl;
let driverPort;
let nativePort;
let driverStartError;

async function webdriver(method, route, body) {
  const response = await fetch(`${driverBaseUrl}${route}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.value?.error) {
    const details = payload.value?.message ?? payload.message ?? response.statusText;
    throw new Error(`WebDriver ${method} ${route} failed (${response.status}): ${details}`);
  }
  return payload.value;
}

async function command(method, route, body) {
  assert.ok(sessionId, "WebDriver session has not started");
  return webdriver(method, `/session/${sessionId}${route}`, body);
}

async function waitFor(description, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

async function findElement(using, value, root = "") {
  const response = await command("POST", `${root}/element`, { using, value });
  return response["element-6066-11e4-a52e-4f735466cecf"];
}

async function findOptional(using, value, root = "") {
  try {
    return await findElement(using, value, root);
  } catch (error) {
    if (/no such element/i.test(error.message)) return null;
    throw error;
  }
}

async function click(elementId) {
  await command("POST", `/element/${elementId}/click`, {});
}

async function execute(script, args = []) {
  return command("POST", "/execute/sync", { script, args });
}

async function textContent(selector) {
  return execute(`return document.querySelector(${JSON.stringify(selector)})?.innerText ?? "";`);
}

async function findByScript(script, args = []) {
  const result = await execute(script, args);
  const elementId = result?.["element-6066-11e4-a52e-4f735466cecf"];
  assert.ok(elementId, `No element matched script: ${script}`);
  return elementId;
}

async function rightClick(elementId) {
  await command("POST", "/actions", {
    actions: [{
      type: "pointer",
      id: "e2e-mouse",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", origin: { "element-6066-11e4-a52e-4f735466cecf": elementId }, x: 0, y: 0 },
        { type: "pointerDown", button: 2 },
        { type: "pointerUp", button: 2 },
      ],
    }],
  });
}

async function findFreePort(excluded = new Set()) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (excluded.has(port)) return findFreePort(excluded);
  return port;
}

async function waitForDriver() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (driverStartError) throw new Error(`tauri-driver failed to start: ${driverStartError.message}`);
    if (driverProcess.exitCode !== null || driverProcess.signalCode !== null) {
      throw new Error(`tauri-driver exited before becoming ready (exit ${driverProcess.exitCode ?? driverProcess.signalCode})`);
    }
    const response = await fetch(`${driverBaseUrl}/status`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (response?.ok) return;
    await delay(200);
  }
  throw new Error(`Timed out waiting for the tauri-driver endpoint at ${driverBaseUrl}`);
}

async function removeTempDirectory(directory) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 7) {
        console.error(`Temporary directory cleanup failed for ${directory}: ${error.message}`);
        return;
      }
      await delay(300);
    }
  }
}

async function run() {
  assert.ok(await stat(appPath).catch(() => null), `Build the desktop app first; executable not found: ${appPath}`);
  assert.ok(await stat(tauriDriver).catch(() => null), `Install tauri-driver first; executable not found: ${tauriDriver}`);
  assert.ok(await stat(path.join(cargoBin, "msedgedriver.exe")).catch(() => null), "Install an msedgedriver matching the installed Edge version first");

  nativePort = await findFreePort();
  driverPort = await findFreePort(new Set([nativePort]));
  driverBaseUrl = `http://127.0.0.1:${driverPort}`;
  await mkdir(nestedPath, { recursive: true });
  await mkdir(path.join(nestedPath, "child"), { recursive: true });
  const webviewProfile = path.join(profileRoot, "profile");
  await mkdir(webviewProfile, { recursive: true });

  driverProcess = spawn(tauriDriver, ["--port", String(driverPort), "--native-port", String(nativePort)], {
    env: {
      ...process.env,
      PATH: `${cargoBin};${process.env.PATH ?? ""}`,
      WEBVIEW2_USER_DATA_FOLDER: webviewProfile,
    },
    stdio: "inherit",
    windowsHide: true,
  });
  driverProcess.once("error", (error) => { driverStartError = error; });
  await waitForDriver();

  const session = await webdriver("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "wry",
        "tauri:options": { application: appPath },
      },
    },
  });
  sessionId = session.sessionId ?? session.session_id;
  assert.ok(sessionId, "tauri-driver returned no WebDriver session id");

  // Seed a disposable workspace before reloading so all filesystem and PTY operations stay isolated.
  if (process.env.YERMINAL_E2E_DEBUG) {
    console.log("WebDriver title:", await command("GET", "/title"));
    console.log("WebDriver URL:", await command("GET", "/url"));
    console.log("WebDriver body:", await execute("return document.body?.innerText ?? \"\";"));
  }
  await waitFor("application root", () => findOptional("css selector", ".app-shell"));
  await execute(`
    const originalSetItem = Storage.prototype.setItem;
    const storage = window.localStorage;
    originalSetItem.call(storage, "yerminal.workspace", JSON.stringify({ folders: [arguments[0]], activePath: arguments[0] }));
    originalSetItem.call(storage, "yerminal.terminal-workspaces", JSON.stringify({ workspaces: [{ id: "e2e", name: "E2E", rootPath: arguments[0], folderPaths: [arguments[0]] }], activeId: "e2e" }));
    Storage.prototype.setItem = function (key, value) {
      if (key === "yerminal.workspace" || key === "yerminal.terminal-workspaces") return;
      return originalSetItem.call(this, key, value);
    };
    return true;
  `, [tempRoot]);
  await command("POST", "/refresh", {});

  // 1. Application opens and initializes a terminal prompt.
  const prompt = await waitFor("terminal prompt", async () => {
    const screen = await findOptional("css selector", ".terminal-instance .xterm-screen");
    if (!screen) return null;
    const rows = await textContent(".terminal-instance .xterm-rows");
    return rows.trim() ? rows : null;
  }, 30_000);
  assert.ok(prompt.trim(), "The terminal screen did not show a shell prompt");
  if (process.env.YERMINAL_E2E_DEBUG) {
    console.log("Seeded workspace state:", await execute("return JSON.stringify([localStorage.getItem(\"yerminal.workspace\"), localStorage.getItem(\"yerminal.terminal-workspaces\")]);"));
    console.log("Seeded page:", await execute("return document.body?.innerText ?? \"\";"));
  }
  console.log("PASS 1: app opened and the terminal prompt rendered");

  // 2. Run a harmless PowerShell command and wait for its unique output marker.
  const input = await findElement("css selector", ".terminal-instance .xterm-helper-textarea");
  const markerSplit = Math.floor(marker.length / 2);
  const commandText = `Write-Output ('${marker.slice(0, markerSplit)}' + '${marker.slice(markerSplit)}')`;
  assert.ok(!commandText.includes(marker), "The command line must not contain the full output marker");
  const keyValues = [...commandText, "\uE007"];
  await command("POST", `/element/${input}/value`, { text: keyValues.join(""), value: keyValues });
  await waitFor(`terminal output ${marker}`, async () => (await textContent(".terminal-instance .xterm-rows")).includes(marker), 15_000);
  console.log("PASS 2: terminal command ran and its output appeared");

  // 3. Expand the nested folder in the real workspace tree.
  await click(await findElement("css selector", 'button[aria-label="Explorer"]'));

  const nestedEntry = await waitFor("nested folder row", () => findByScript(`return [...document.querySelectorAll(".workspace-tree-entry")].find((element) => element.textContent.trim() === "nested") ?? null;`).catch((error) => { if (/No element matched/.test(error.message)) return null; throw error; }));
  const expandNested = await waitFor("nested folder expand button", () => findOptional("css selector", 'button.workspace-tree-toggle[aria-label="Expand nested"]'));
  await click(expandNested);
  await waitFor("nested child folder row", () => findByScript(`return [...document.querySelectorAll(".workspace-tree-entry")].find((element) => element.textContent.trim() === "child") ?? null;`).catch((error) => { if (/No element matched/.test(error.message)) return null; throw error; }));
  console.log("PASS 3: Explorer expanded the nested folder and listed its child");

  // 4. Open the folder in a distinct terminal, verify its actual cwd, and preserve the first session.
  await rightClick(nestedEntry);
  const openTerminalMenuItem = await waitFor("Open in Terminal menu item", () => findOptional("xpath", "//button[@role='menuitem' and normalize-space(.)='Open in Terminal']"));
  assert.ok(openTerminalMenuItem, "The Open in Terminal action did not appear");
  await click(openTerminalMenuItem);

  await waitFor("two terminal sessions", async () => {
    const count = await execute("return document.querySelectorAll('.terminal-instance').length;");
    const tabs = await execute("return document.querySelectorAll('[role=tablist][aria-label=\"Terminal sessions\"] [role=tab]').length;");
    return count === 2 && tabs === 2;
  });
  await waitFor("new terminal PowerShell prompt", async () => {
    const output = await textContent('.terminal-pane-frame[data-active="true"] .xterm-rows');
    return /PS [A-Z]:\\/i.test(output) ? output : null;
  }, 30_000);
  const cwdMarker = `YERMINAL_E2E_CWD_${Date.now()}`;
  const cwdInput = await waitFor("new terminal input", () => findOptional("css selector", '.terminal-pane-frame[data-active="true"] .xterm-helper-textarea'));
  const cwdCommand = `Write-Output ('${cwdMarker}=' + (Get-Location).Path)`;
  const expectedCwdOutput = `${cwdMarker}=${nestedPath}`;
  assert.ok(!cwdCommand.toLowerCase().includes(expectedCwdOutput.toLowerCase()), "The command line must not contain the full expected cwd output");
  const cwdKeyValues = [...cwdCommand, "\uE007"];
  await command("POST", `/element/${cwdInput}/value`, { text: cwdKeyValues.join(""), value: cwdKeyValues });
  await waitFor("new terminal reports the target working directory", async () => {
    const output = await textContent('.terminal-pane-frame[data-active="true"] .xterm-rows');
    return output.toLowerCase().includes(expectedCwdOutput.toLowerCase());
  }, 15_000);
  const preservedSessions = await execute(`
    return {
      terminalCount: document.querySelectorAll(".terminal-instance").length,
      tabCount: document.querySelectorAll('[role=tablist][aria-label="Terminal sessions"] [role=tab]').length,
      originalOutputPresent: [...document.querySelectorAll(".terminal-pane-frame .xterm-rows")].some((element) => element.textContent.includes(arguments[0])),
    };
  `, [marker]);
  assert.equal(preservedSessions.terminalCount, 2, "Opening a folder should keep both terminal sessions mounted");
  assert.equal(preservedSessions.tabCount, 2, "Opening a folder should preserve the previous terminal tab");
  assert.equal(preservedSessions.originalOutputPresent, true, "The previous terminal output should remain in its session");
  console.log("PASS 4: Open in Terminal created a second session at the target folder and preserved the first session");

  // 5. Right-click the folder, choose New File, answer the filename prompt, and verify disk output.
  await rightClick(nestedEntry);
  const menu = await waitFor("folder context menu", () => findOptional("css selector", '[role="menu"][aria-label="Folder actions"]'));
  assert.ok(menu, "The folder context menu did not open");
  await click(await findElement("css selector", '[role="menuitem"]', `/element/${menu}`));
  await waitFor("native New File prompt", () => webdriver("GET", `/session/${sessionId}/alert/text`).then((value) => value !== null));
  await webdriver("POST", `/session/${sessionId}/alert/text`, { text: path.basename(resultFile) });
  await webdriver("POST", `/session/${sessionId}/alert/accept`, {});
  await waitFor("created file", () => stat(resultFile).catch(() => null), 10_000);
  console.log("PASS 5: New File created a file inside the temporary workspace");
}

try {
  await run();
} finally {
  if (sessionId) {
    await webdriver("DELETE", `/session/${sessionId}`).catch((error) => console.error(`WebDriver cleanup: ${error.message}`));
  }
  if (driverProcess && !driverProcess.killed) driverProcess.kill();
  await delay(500);
  await removeTempDirectory(tempRoot);
  await removeTempDirectory(profileRoot);
}
