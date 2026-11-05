use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize, PtySystem};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShellKind {
    Powershell,
    Bash,
    Zsh,
}

#[derive(Serialize)]
pub struct TerminalInfo {
    pub id: String,
    pub shell: String,
    pub working_directory: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: String,
    data: String,
}

struct TerminalSession {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
}

#[derive(Default)]
pub struct SessionManager {
    sessions: HashMap<String, Arc<TerminalSession>>,
}

impl SessionManager {
    pub fn create(
        &mut self,
        app: AppHandle,
        id: String,
        shell: ShellKind,
        working_directory: Option<String>,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalInfo, String> {
        if id.is_empty() || id.len() > 64 || !id.chars().all(|character| character.is_ascii_alphanumeric() || character == '-') {
            return Err("Invalid terminal session identifier".to_owned());
        }
        if self.sessions.contains_key(&id) {
            return Err("Terminal session identifier already exists".to_owned());
        }
        let cwd = resolve_working_directory(working_directory)?;
        let executable = resolve_shell(shell)?;
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows: rows.clamp(2, 300), cols: cols.clamp(2, 500), pixel_width: 0, pixel_height: 0 })
            .map_err(|error| format!("Could not create terminal: {error}"))?;

        let mut command = CommandBuilder::new(&executable);
        command.cwd(&cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let reader = pair.master.try_clone_reader()
            .map_err(|error| format!("Could not open terminal output: {error}"))?;
        let writer = pair.master.take_writer()
            .map_err(|error| format!("Could not open terminal input: {error}"))?;
        let child = pair.slave.spawn_command(command)
            .map_err(|error| format!("Could not start {executable}: {error}"))?;
        drop(pair.slave);

        let session = Arc::new(TerminalSession {
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
        });
        self.sessions.insert(id.clone(), Arc::clone(&session));
        if let Err(error) = spawn_output_reader(app, id.clone(), reader) {
            let _ = self.close(&id);
            return Err(error);
        }

        Ok(TerminalInfo {
            id,
            shell: shell.label().to_owned(),
            working_directory: cwd.to_string_lossy().into_owned(),
        })
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let session = self.session(id)?;
        let mut writer = session.writer.lock().map_err(|_| "Terminal input is unavailable".to_owned())?;
        writer.write_all(data.as_bytes()).and_then(|_| writer.flush())
            .map_err(|error| format!("Could not write to terminal: {error}"))
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.session(id)?;
        let master = session.master.lock().map_err(|_| "Terminal resize is unavailable".to_owned())?;
        master.resize(PtySize { rows: rows.clamp(2, 300), cols: cols.clamp(2, 500), pixel_width: 0, pixel_height: 0 })
            .map_err(|error| format!("Could not resize terminal: {error}"))
    }

    pub fn close(&mut self, id: &str) -> Result<(), String> {
        let session = self.sessions.remove(id).ok_or_else(|| "Terminal session was not found".to_owned())?;
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }

    pub fn close_all(&mut self) {
        for (_, session) in self.sessions.drain() {
            if let Ok(mut child) = session.child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    fn session(&self, id: &str) -> Result<Arc<TerminalSession>, String> {
        self.sessions.get(id).cloned().ok_or_else(|| "Terminal session was not found".to_owned())
    }
}

impl ShellKind {
    fn label(self) -> &'static str {
        match self { Self::Powershell => "PowerShell", Self::Bash => "Bash", Self::Zsh => "Zsh" }
    }
}

fn resolve_working_directory(value: Option<String>) -> Result<PathBuf, String> {
    let path = match value {
        Some(value) => PathBuf::from(value),
        None => std::env::current_dir().map_err(|error| format!("Could not locate the working directory: {error}"))?,
    };
    if !path.is_dir() {
        return Err(format!("Working directory does not exist: {}", path.display()));
    }
    path.canonicalize().map_err(|error| format!("Could not open working directory: {error}"))
}

fn resolve_shell(shell: ShellKind) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    let candidates: Vec<String> = match shell {
        ShellKind::Powershell => vec!["powershell.exe".into(), "pwsh.exe".into()],
        ShellKind::Bash => vec!["bash.exe".into()],
        ShellKind::Zsh => vec!["zsh.exe".into()],
    };
    #[cfg(not(target_os = "windows"))]
    let candidates: Vec<String> = match shell {
        ShellKind::Powershell => vec!["pwsh".into()],
        ShellKind::Bash => vec!["bash".into()],
        ShellKind::Zsh => vec!["zsh".into()],
    };
    candidates.into_iter().find(|candidate| executable_on_path(candidate))
        .ok_or_else(|| format!("{} is not installed or not available on PATH", shell.label()))
}

fn executable_on_path(executable: &str) -> bool {
    if executable.contains(std::path::MAIN_SEPARATOR) {
        return PathBuf::from(executable).is_file();
    }
    std::env::var_os("PATH").into_iter().flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .any(|directory| directory.join(executable).is_file())
}

fn spawn_output_reader(app: AppHandle, session_id: String, mut reader: Box<dyn Read + Send>) -> Result<(), String> {
    thread::Builder::new().name(format!("pty-output-{session_id}")).spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => {
                    let data = String::from_utf8_lossy(&buffer[..length]).into_owned();
                    if app.emit("terminal-output", TerminalOutput { session_id: session_id.clone(), data }).is_err() {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let _ = app.emit("terminal-exited", session_id);
    }).map(|_| ()).map_err(|error| format!("Could not start terminal output worker: {error}"))
}
