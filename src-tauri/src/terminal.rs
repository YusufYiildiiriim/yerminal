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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub session_id: String,
    pub sequence: u64,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug)]
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
pub const MAX_TERMINAL_INPUT_BYTES: usize = 64 * 1024;

fn validate_terminal_input(data: &str) -> Result<(), String> {
    if data.len() > MAX_TERMINAL_INPUT_BYTES {
        return Err("Terminal input chunk is too large".to_owned());
    }
    Ok(())
}

/// Write handle for one terminal session that does not borrow the
/// `SessionManager`, so the global manager lock is not held while writing.
pub struct TerminalInput(Arc<TerminalSession>);

impl TerminalInput {
    pub fn write(&self, data: &str) -> Result<(), String> {
        validate_terminal_input(data)?;
        let mut writer = self
            .0
            .writer
            .lock()
            .map_err(|_| "Terminal input is unavailable".to_owned())?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| format!("Could not write to terminal: {error}"))
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

    /// Looks up a session's input handle so callers can release the manager
    /// lock before performing the (potentially blocking) PTY write.
    pub fn input(&self, id: &str) -> Result<TerminalInput, String> {
        self.session(id).map(TerminalInput)
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        validate_terminal_input(data)?;
        self.input(id)?.write(data)
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
    let canonical_path = path
        .canonicalize()
        .map_err(|error| format!("Could not open working directory: {error}"))?;
    #[cfg(windows)]
    let canonical_path = normalize_windows_working_directory(canonical_path);
    Ok(canonical_path)
}

#[cfg(windows)]
fn normalize_windows_working_directory(path: PathBuf) -> PathBuf {
    let path_text = path.to_string_lossy().into_owned();
    if let Some(unc_path) = path_text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{unc_path}"))
    } else if let Some(dos_path) = path_text.strip_prefix(r"\\?\") {
        PathBuf::from(dos_path)
    } else {
        path
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_history_assigns_increasing_sequences() {
        let mut history = TerminalOutputHistory::default();

        let first = history.append("session-a".to_owned(), "first\n".to_owned());
        let second = history.append("session-a".to_owned(), "second\r\n".to_owned());
        let third = history.append("session-a".to_owned(), "third".to_owned());

        assert_eq!(first.sequence, 1);
        assert_eq!(second.sequence, 2);
        assert_eq!(third.sequence, 3);

        let snapshot = history.snapshot();
        assert_eq!(snapshot.through_sequence, 3);
        assert_eq!(snapshot.events.len(), 3);
        assert_eq!(snapshot.events[0].session_id, "session-a");
        assert_eq!(snapshot.events[0].data, "first\n");
        assert_eq!(snapshot.events[2].data, "third");
    }

    #[test]
    fn output_history_evicts_old_events_within_retention_limit() {
        let mut history = TerminalOutputHistory::default();

        for index in 0..300 {
            let data = format!("event-{index:04}-{}", "x".repeat(2000));
            history.append("session-a".to_owned(), data);
        }

        let snapshot = history.snapshot();
        assert_eq!(snapshot.through_sequence, 300);
        assert!(
            snapshot.events.len() < 300,
            "history should evict older events"
        );

        let retained_bytes: usize = snapshot.events.iter().map(|event| event.data.len()).sum();
        assert!(
            retained_bytes <= 256 * 1024,
            "retained {retained_bytes} bytes exceeds 256 KiB"
        );

        let newest = snapshot.events.last().expect("history keeps recent events");
        assert_eq!(newest.sequence, 300);
        assert!(newest.data.starts_with("event-0299-"));
        assert!(newest.data.ends_with("xxxxxxxxxx"));
    }

    #[test]
    fn unknown_session_operations_report_missing_sessions() {
        let mut manager = SessionManager::default();

        let snapshot_error = manager.output_snapshot("ghost").unwrap_err();
        assert!(
            snapshot_error.contains("Terminal session was not found"),
            "{snapshot_error}"
        );

        let write_error = manager.write("ghost", "hello").unwrap_err();
        assert!(
            write_error.contains("Terminal session was not found"),
            "{write_error}"
        );

        let resize_error = manager.resize("ghost", 80, 24).unwrap_err();
        assert!(
            resize_error.contains("Terminal session was not found"),
            "{resize_error}"
        );

        let close_error = manager.close("ghost").unwrap_err();
        assert!(
            close_error.contains("Terminal session was not found"),
            "{close_error}"
        );
    }

    #[test]
    fn write_rejects_oversized_input_before_session_lookup() {
        let manager = SessionManager::default();

        let at_limit = "a".repeat(64 * 1024);
        let missing = manager.write("ghost", &at_limit).unwrap_err();
        assert!(
            missing.contains("Terminal session was not found"),
            "{missing}"
        );

        let over_limit = "a".repeat(64 * 1024 + 1);
        let too_large = manager.write("ghost", &over_limit).unwrap_err();
        assert!(too_large.contains("too large"), "{too_large}");

        assert!(validate_terminal_input("").is_ok());
        assert!(validate_terminal_input(&at_limit).is_ok());
        assert!(validate_terminal_input(&over_limit).is_err());
        // Multi-byte input is limited by encoded size, not character count.
        let multibyte = "ş".repeat(MAX_TERMINAL_INPUT_BYTES / 2 + 1);
        assert!(validate_terminal_input(&multibyte).is_err());
    }

    #[test]
    fn process_roots_report_unknown_sessions_and_limit_batch_size() {
        let manager = SessionManager::default();

        let ids: Vec<String> = (0..2).map(|index| format!("unknown-{index}")).collect();
        let roots = manager.process_roots(&ids).expect("process roots");
        assert_eq!(roots.len(), ids.len());

        let too_many: Vec<String> = (0..129).map(|index| format!("unknown-{index}")).collect();
        let error = manager.process_roots(&too_many).unwrap_err();
        assert!(error.contains("Too many terminal sessions"), "{error}");
    }

    #[cfg(windows)]
    #[test]
    fn normalize_windows_working_directory_strips_extended_prefixes() {
        assert_eq!(
            normalize_windows_working_directory(PathBuf::from(r"\\?\UNC\server\share\dir")),
            PathBuf::from(r"\\server\share\dir")
        );
        assert_eq!(
            normalize_windows_working_directory(PathBuf::from(r"\\?\C:\Proj")),
            PathBuf::from(r"C:\Proj")
        );
        assert_eq!(
            normalize_windows_working_directory(PathBuf::from(r"C:\Proj\Sub")),
            PathBuf::from(r"C:\Proj\Sub")
        );
    }

    #[test]
    fn resolve_working_directory_rejects_missing_folders() {
        let error =
            resolve_working_directory(Some("definitely-not-a-real-folder-yerminal".to_owned()))
                .unwrap_err();
        assert!(
            error.contains("Working directory does not exist"),
            "{error}"
        );
    }

    #[test]
    fn resolve_working_directory_canonicalizes_existing_folders() {
        let dir = tempfile::tempdir().expect("create temp directory");

        let resolved = resolve_working_directory(Some(dir.path().to_string_lossy().into_owned()))
            .expect("resolve working directory");

        assert!(resolved.is_dir());
        #[cfg(windows)]
        assert!(
            !resolved.to_string_lossy().contains(r"\\?\"),
            "canonical path should drop the extended prefix: {}",
            resolved.to_string_lossy()
        );
    }

    #[test]
    fn resolve_working_directory_defaults_to_current_directory() {
        let resolved = resolve_working_directory(None).expect("resolve default directory");
        assert!(resolved.is_dir());
    }

    #[test]
    fn resolve_program_rejects_unknown_programs_on_path() {
        let error = resolve_program("definitely-not-a-real-program-xyz").unwrap_err();
        assert!(error.contains("was not found on PATH"), "{error}");
    }

    #[test]
    fn resolve_program_finds_path_executables() {
        #[cfg(windows)]
        let program = "cmd";
        #[cfg(not(windows))]
        let program = "sh";

        let resolved = resolve_program(program).expect("resolve program");
        assert!(
            std::path::Path::new(&resolved).is_file(),
            "resolved program must exist: {resolved}"
        );
    }

    #[test]
    fn resolve_program_rejects_missing_local_paths() {
        let separator = std::path::MAIN_SEPARATOR;
        let missing = format!(".{separator}definitely-not-here{separator}tool.exe");

        let error = resolve_program(&missing).unwrap_err();
        assert!(
            error.contains("Configured executable was not found"),
            "{error}"
        );
        assert!(
            !error.contains("on PATH"),
            "local path failures should not mention PATH: {error}"
        );
    }

    #[test]
    fn shell_kind_labels_use_friendly_names() {
        assert_eq!(ShellKind::Powershell.label(), "PowerShell");
        assert_eq!(ShellKind::Bash.label(), "Bash");
        assert_eq!(ShellKind::Zsh.label(), "Zsh");
    }

    #[test]
    fn bundled_agent_config_parses_with_valid_profiles() {
        let content = include_str!("../agents.toml");
        let config = toml::from_str::<AgentConfig>(content)
            .expect("bundled agents.toml should parse as AgentConfig");

        assert!(!config.agents.is_empty(), "bundled agents list is empty");
        assert!(config.agents.len() <= 20, "profiles exceed supported limit");
        for profile in &config.agents {
            assert!(!profile.id.is_empty(), "profile id is empty");
            assert!(!profile.command.is_empty(), "profile command is empty");
            assert!(profile.args.len() <= 32, "profile has too many args");
            assert!(profile.id.len() <= 64, "profile id is too long");
        }
    }

    // Note: a portable-pty ConPTY smoke test (spawn `cmd /C echo`, read through
    // the master) was attempted here and removed. In this headless environment,
    // ConPTY children (cmd /C echo) never exit and the master pipe produces no
    // output and never EOFs, so the smoke test could only time out. Session
    // lifecycle paths that need a Tauri AppHandle are out of scope anyway; real
    // PTY behavior is covered by the app's manual testing.
}
