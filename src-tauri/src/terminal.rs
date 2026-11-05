use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

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

#[derive(Clone, Deserialize)]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Deserialize)]
struct AgentConfig {
    agents: Vec<AgentProfile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileInfo {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: String,
    data: String,
}

struct TerminalSession {
    shell: String,
    working_directory: String,
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
        if let Some(info) = self.existing_info(&id) {
            return Ok(info);
        }
        let cwd = resolve_working_directory(working_directory)?;
        let executable = resolve_shell(shell)?;
        self.spawn_process(
            app,
            id,
            executable,
            Vec::new(),
            shell.label().to_owned(),
            cwd,
            cols,
            rows,
        )
    }

    pub fn create_agent(
        &mut self,
        app: AppHandle,
        id: String,
        profile_id: &str,
        working_directory: Option<String>,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalInfo, String> {
        if let Some(info) = self.existing_info(&id) {
            return Ok(info);
        }
        let profile = load_agent_profiles(&app)?
            .into_iter()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| format!("Unknown agent profile: {profile_id}"))?;
        if let Some(info) = self.existing_info(&id) {
            return Ok(info);
        }
        let cwd = resolve_working_directory(working_directory)?;
        let executable = resolve_program(&profile.command)?;
        self.spawn_process(
            app,
            id,
            executable,
            profile.args,
            profile.name,
            cwd,
            cols,
            rows,
        )
    }

    fn existing_info(&self, id: &str) -> Option<TerminalInfo> {
        self.sessions.get(id).map(|session| TerminalInfo {
            id: id.to_owned(),
            shell: session.shell.clone(),
            working_directory: session.working_directory.clone(),
        })
    }

    fn spawn_process(
        &mut self,
        app: AppHandle,
        id: String,
        executable: String,
        args: Vec<String>,
        label: String,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalInfo, String> {
        if id.is_empty()
            || id.len() > 64
            || !id
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-')
        {
            return Err("Invalid terminal session identifier".to_owned());
        }
        if self.sessions.contains_key(&id) {
            return Err("Terminal session identifier already exists".to_owned());
        }
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: rows.clamp(2, 300),
                cols: cols.clamp(2, 500),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("Could not create terminal: {error}"))?;

        let mut command = CommandBuilder::new(&executable);
        command.args(args);
        command.cwd(&cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("Could not open terminal output: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("Could not open terminal input: {error}"))?;
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("Could not start {executable}: {error}"))?;
        drop(pair.slave);

        let working_directory = cwd.to_string_lossy().into_owned();
        let session = Arc::new(TerminalSession {
            shell: label.clone(),
            working_directory: working_directory.clone(),
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
            shell: label,
            working_directory,
        })
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let session = self.session(id)?;
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| "Terminal input is unavailable".to_owned())?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| format!("Could not write to terminal: {error}"))
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.session(id)?;
        let master = session
            .master
            .lock()
            .map_err(|_| "Terminal resize is unavailable".to_owned())?;
        master
            .resize(PtySize {
                rows: rows.clamp(2, 300),
                cols: cols.clamp(2, 500),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("Could not resize terminal: {error}"))
    }

    pub fn close(&mut self, id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .remove(id)
            .ok_or_else(|| "Terminal session was not found".to_owned())?;
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
        self.sessions
            .get(id)
            .cloned()
            .ok_or_else(|| "Terminal session was not found".to_owned())
    }
}

pub fn load_agent_profiles(app: &AppHandle) -> Result<Vec<AgentProfile>, String> {
    let config_directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Could not locate app configuration folder: {error}"))?;
    fs::create_dir_all(&config_directory)
        .map_err(|error| format!("Could not create app configuration folder: {error}"))?;
    let path = config_directory.join("agents.toml");
    if !path.exists() {
        fs::write(&path, include_str!("../agents.toml"))
            .map_err(|error| format!("Could not create default agent profiles: {error}"))?;
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Could not read agent profiles: {error}"))?;
    let profiles = toml::from_str::<AgentConfig>(&content)
        .map_err(|error| format!("Could not parse agent profiles: {error}"))?
        .agents;
    if profiles.len() > 20
        || profiles.iter().any(|profile| {
            profile.id.is_empty()
                || profile.id.len() > 64
                || profile.command.is_empty()
                || profile.args.len() > 32
        })
    {
        return Err(
            "Agent profiles exceed the supported limits or contain an invalid profile".to_owned(),
        );
    }
    Ok(profiles)
}

pub fn agent_profile_list(app: &AppHandle) -> Result<Vec<AgentProfileInfo>, String> {
    load_agent_profiles(app).map(|profiles| {
        profiles
            .into_iter()
            .map(|profile| AgentProfileInfo {
                id: profile.id,
                name: profile.name,
            })
            .collect()
    })
}

impl ShellKind {
    fn label(self) -> &'static str {
        match self {
            Self::Powershell => "PowerShell",
            Self::Bash => "Bash",
            Self::Zsh => "Zsh",
        }
    }
}

fn resolve_working_directory(value: Option<String>) -> Result<PathBuf, String> {
    let path = match value {
        Some(value) => PathBuf::from(value),
        None => std::env::current_dir()
            .map_err(|error| format!("Could not locate the working directory: {error}"))?,
    };
    if !path.is_dir() {
        return Err(format!(
            "Working directory does not exist: {}",
            path.display()
        ));
    }
    path.canonicalize()
        .map_err(|error| format!("Could not open working directory: {error}"))
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
    candidates
        .into_iter()
        .find_map(|candidate| resolve_program(&candidate).ok())
        .ok_or_else(|| {
            format!(
                "{} is not installed or not available on PATH",
                shell.label()
            )
        })
}

fn resolve_program(program: &str) -> Result<String, String> {
    let path = PathBuf::from(program);
    if path.is_absolute() || program.contains(std::path::MAIN_SEPARATOR) {
        return path
            .is_file()
            .then(|| path.to_string_lossy().into_owned())
            .ok_or_else(|| format!("Configured executable was not found: {program}"));
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&paths) {
            let candidate = directory.join(program);
            if candidate.is_file() {
                return Ok(candidate.to_string_lossy().into_owned());
            }
            #[cfg(target_os = "windows")]
            for extension in ["exe", "cmd", "bat"] {
                let candidate = directory.join(format!("{program}.{extension}"));
                if candidate.is_file() {
                    return Ok(candidate.to_string_lossy().into_owned());
                }
            }
        }
    }
    Err(format!(
        "Configured executable was not found on PATH: {program}"
    ))
}

fn spawn_output_reader(
    app: AppHandle,
    session_id: String,
    mut reader: Box<dyn Read + Send>,
) -> Result<(), String> {
    thread::Builder::new()
        .name(format!("pty-output-{session_id}"))
        .spawn(move || {
            let mut buffer = [0_u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => {
                        let data = String::from_utf8_lossy(&buffer[..length]).into_owned();
                        if app
                            .emit(
                                "terminal-output",
                                TerminalOutput {
                                    session_id: session_id.clone(),
                                    data,
                                },
                            )
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let _ = app.emit("terminal-exited", session_id);
        })
        .map(|_| ())
        .map_err(|error| format!("Could not start terminal output worker: {error}"))
}
