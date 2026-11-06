use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResourceUsage {
    pub session_id: String,
    pub available: bool,
    pub process_count: usize,
    pub memory_bytes: u64,
    pub cpu_percent: Option<f32>,
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
pub struct TerminalOutput {
    pub session_id: String,
    pub sequence: u64,
    pub data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputSnapshot {
    pub through_sequence: u64,
    pub events: Vec<TerminalOutput>,
}

#[derive(Default)]
struct TerminalOutputHistory {
    next_sequence: u64,
    retained_bytes: usize,
    events: VecDeque<TerminalOutput>,
}

impl TerminalOutputHistory {
    fn append(&mut self, session_id: String, data: String) -> TerminalOutput {
        self.next_sequence = self.next_sequence.saturating_add(1);
        let event = TerminalOutput {
            session_id,
            sequence: self.next_sequence,
            data,
        };
        self.retained_bytes = self.retained_bytes.saturating_add(event.data.len());
        self.events.push_back(event.clone());
        while self.retained_bytes > 256 * 1024 && self.events.len() > 1 {
            if let Some(removed) = self.events.pop_front() {
                self.retained_bytes = self.retained_bytes.saturating_sub(removed.data.len());
            }
        }
        event
    }

    fn snapshot(&self) -> TerminalOutputSnapshot {
        TerminalOutputSnapshot {
            through_sequence: self.next_sequence,
            events: self.events.iter().cloned().collect(),
        }
    }
}

struct TerminalSession {
    process_id: Option<u32>,
    process_start_time: Option<u64>,
    shell: String,
    working_directory: String,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    output_history: Arc<Mutex<TerminalOutputHistory>>,
}

pub(crate) struct TerminalProcessRoot {
    session_id: String,
    process_id: Option<u32>,
    process_start_time: Option<u64>,
    running: bool,
}

pub struct TerminalResourceMonitor {
    metrics_system: Option<System>,
    previous_process_start_times: HashMap<Pid, u64>,
}

impl Default for TerminalResourceMonitor {
    fn default() -> Self {
        Self {
            metrics_system: System::new().ok(),
            previous_process_start_times: HashMap::new(),
        }
    }
}

impl TerminalResourceMonitor {
    pub(crate) fn collect(
        &mut self,
        roots: Vec<TerminalProcessRoot>,
    ) -> Vec<TerminalResourceUsage> {
        let Some(metrics_system) = self.metrics_system.as_mut() else {
            return roots
                .into_iter()
                .map(|root| TerminalResourceUsage::unavailable(root.session_id))
                .collect();
        };

        metrics_system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );

        let process_start_times: HashMap<Pid, u64> = metrics_system
            .processes()
            .iter()
            .map(|(pid, process)| (pid.clone(), process.start_time()))
            .collect();
        let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
        for (pid, process) in metrics_system.processes() {
            if let Some(parent_pid) = process.parent() {
                let parent_start_time = metrics_system
                    .process(parent_pid.clone())
                    .map(|parent| parent.start_time());
                if parent_start_time.is_some_and(|start_time| process.start_time() >= start_time) {
                    children.entry(parent_pid).or_default().push(pid.clone());
                }
            }
        }

        let cpu_count = std::thread::available_parallelism()
            .map(|count| count.get() as f32)
            .unwrap_or(1.0);
        let metrics = roots
            .into_iter()
            .map(|root| {
                let Some(process_id) = root.process_id else {
                    return TerminalResourceUsage::unavailable(root.session_id);
                };
                let Some(expected_start_time) = root.process_start_time else {
                    return TerminalResourceUsage::unavailable(root.session_id);
                };
                if !root.running {
                    return TerminalResourceUsage::unavailable(root.session_id);
                }

                let root_pid = Pid::from(process_id as usize);
                if metrics_system
                    .process(root_pid.clone())
                    .is_none_or(|process| process.start_time() != expected_start_time)
                {
                    return TerminalResourceUsage::unavailable(root.session_id);
                }

                let mut process_ids = HashSet::new();
                let mut pending = vec![root_pid.clone()];
                while let Some(parent_pid) = pending.pop() {
                    if !process_ids.insert(parent_pid.clone()) {
                        continue;
                    }
                    if let Some(child_pids) = children.get(&parent_pid) {
                        pending.extend(child_pids.iter().cloned());
                    }
                }

                let cpu_ready = process_ids.iter().all(|pid| {
                    self.previous_process_start_times.get(pid) == process_start_times.get(pid)
                });
                let mut memory_bytes = 0u64;
                let mut cpu_usage = 0.0f32;
                for pid in &process_ids {
                    if let Some(process) = metrics_system.process(pid.clone()) {
                        memory_bytes = memory_bytes.saturating_add(process.memory());
                        cpu_usage += process.cpu_usage();
                    }
                }

                TerminalResourceUsage {
                    session_id: root.session_id,
                    available: true,
                    process_count: process_ids.len(),
                    memory_bytes,
                    cpu_percent: cpu_ready.then(|| (cpu_usage / cpu_count).clamp(0.0, 100.0)),
                }
            })
            .collect();

        self.previous_process_start_times = process_start_times;
        metrics
    }
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

    pub fn output_snapshot(&self, id: &str) -> Result<TerminalOutputSnapshot, String> {
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| "Terminal session was not found".to_owned())?;
        let history = session
            .output_history
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok(history.snapshot())
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
        let process_id = child.process_id();
        let process_start_time = process_id.and_then(read_process_start_time);
        drop(pair.slave);

        let working_directory = cwd.to_string_lossy().into_owned();
        let output_history = Arc::new(Mutex::new(TerminalOutputHistory::default()));
        let session = Arc::new(TerminalSession {
            process_id,
            process_start_time,
            shell: label.clone(),
            working_directory: working_directory.clone(),
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            output_history: Arc::clone(&output_history),
        });
        self.sessions.insert(id.clone(), Arc::clone(&session));
        if let Err(error) = spawn_output_reader(app, id.clone(), reader, output_history) {
            let _ = self.close(&id);
            return Err(error);
        }

        Ok(TerminalInfo {
            id,
            shell: label,
            working_directory,
        })
    }

    pub(crate) fn process_roots(
        &self,
        session_ids: &[String],
    ) -> Result<Vec<TerminalProcessRoot>, String> {
        if session_ids.len() > 128 {
            return Err("Too many terminal sessions requested".to_owned());
        }
        Ok(session_ids
            .iter()
            .map(|id| {
                let Some(session) = self.sessions.get(id) else {
                    return TerminalProcessRoot {
                        session_id: id.clone(),
                        process_id: None,
                        process_start_time: None,
                        running: false,
                    };
                };
                let running = session
                    .child
                    .lock()
                    .map(|mut child| matches!(child.try_wait(), Ok(None)))
                    .unwrap_or(false);
                TerminalProcessRoot {
                    session_id: id.clone(),
                    process_id: session.process_id,
                    process_start_time: session.process_start_time,
                    running,
                }
            })
            .collect())
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

fn read_process_start_time(process_id: u32) -> Option<u64> {
    let mut system = System::new().ok()?;
    let pid = Pid::from(process_id as usize);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid.clone()]),
        true,
        ProcessRefreshKind::nothing(),
    );
    system.process(pid).map(|process| process.start_time())
}

impl TerminalResourceUsage {
    fn unavailable(session_id: String) -> Self {
        Self {
            session_id,
            available: false,
            process_count: 0,
            memory_bytes: 0,
            cpu_percent: None,
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
    output_history: Arc<Mutex<TerminalOutputHistory>>,
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
                        let event = output_history
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .append(session_id.clone(), data);
                        let _ = app.emit("terminal-output", event);
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
