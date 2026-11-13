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
    output_gate: Arc<OutputGate>,
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

    /// Returns the running session registered under `id`. A session whose
    /// process has exited is reaped instead, so `create` spawns a fresh one
    /// rather than reattaching the UI to a dead terminal.
    fn existing_info(&mut self, id: &str) -> Option<TerminalInfo> {
        let exited = self.sessions.get(id).is_some_and(|session| {
            session
                .child
                .lock()
                .map(|mut child| !matches!(child.try_wait(), Ok(None)))
                .unwrap_or(true)
        });
        if exited {
            let _ = self.close(id);
            return None;
        }
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
        let output_gate = Arc::new(OutputGate::new());
        let session = Arc::new(TerminalSession {
            process_id,
            process_start_time,
            shell: label.clone(),
            working_directory: working_directory.clone(),
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            output_history: Arc::clone(&output_history),
            output_gate: Arc::clone(&output_gate),
        });
        self.sessions.insert(id.clone(), Arc::clone(&session));
        if let Err(error) =
            spawn_output_reader(app, id.clone(), reader, output_history, output_gate)
        {
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
        // Silence the reader first: the id may be reused by a new session.
        session.output_gate.deactivate();
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }

    pub fn close_all(&mut self) {
        for (_, session) in self.sessions.drain() {
            session.output_gate.deactivate();
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
    let pathext = std::env::var("PATHEXT").ok();
    resolve_program_in(
        program,
        std::env::var_os("PATH").as_deref(),
        pathext.as_deref(),
    )
}

/// Resolves `program` against an explicit search path (and, on Windows, an
/// explicit PATHEXT list) so the lookup order is testable without touching
/// the process environment.
fn resolve_program_in(
    program: &str,
    search_path: Option<&std::ffi::OsStr>,
    pathext: Option<&str>,
) -> Result<String, String> {
    let path = PathBuf::from(program);
    if path.is_absolute() || program.contains(std::path::MAIN_SEPARATOR) {
        return path
            .is_file()
            .then(|| path.to_string_lossy().into_owned())
            .ok_or_else(|| format!("Configured executable was not found: {program}"));
    }
    if let Some(paths) = search_path {
        let names = program_file_names(program, pathext);
        for directory in std::env::split_paths(paths) {
            for name in &names {
                let candidate = directory.join(name);
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

/// Windows candidates: PATHEXT extensions first (in PATHEXT order), then the
/// bare name. Only extensions CreateProcess can start are used, so an npm
/// install's extensionless shell shim no longer shadows `tool.cmd`.
#[cfg(target_os = "windows")]
fn program_file_names(program: &str, pathext: Option<&str>) -> Vec<String> {
    const LAUNCHABLE: [&str; 4] = [".com", ".exe", ".bat", ".cmd"];
    let pathext = pathext
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(".COM;.EXE;.BAT;.CMD");
    let mut names: Vec<String> = Vec::new();
    for extension in pathext.split(';').map(str::trim) {
        let lower = extension.to_ascii_lowercase();
        if !LAUNCHABLE.contains(&lower.as_str()) {
            continue;
        }
        let name = format!("{program}{lower}");
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names.push(program.to_owned());
    names
}

#[cfg(not(target_os = "windows"))]
fn program_file_names(program: &str, _pathext: Option<&str>) -> Vec<String> {
    vec![program.to_owned()]
}

/// Decodes a byte stream that arrives in arbitrary chunks as UTF-8. A
/// multi-byte character split across two reads is carried over (at most 3
/// bytes) instead of being replaced with U+FFFD; genuinely invalid bytes are
/// still replaced.
#[derive(Default)]
struct Utf8ChunkDecoder {
    pending: Vec<u8>,
}

impl Utf8ChunkDecoder {
    fn decode(&mut self, chunk: &[u8]) -> String {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(chunk);
        let mut output = String::with_capacity(bytes.len());
        let mut rest = bytes.as_slice();
        loop {
            match std::str::from_utf8(rest) {
                Ok(valid) => {
                    output.push_str(valid);
                    break;
                }
                Err(error) => {
                    let (valid, after) = rest.split_at(error.valid_up_to());
                    // `valid_up_to` guarantees this prefix is valid UTF-8.
                    output.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match error.error_len() {
                        Some(invalid_length) => {
                            output.push(char::REPLACEMENT_CHARACTER);
                            rest = &after[invalid_length..];
                        }
                        None => {
                            // Incomplete sequence at the end: wait for more bytes.
                            self.pending = after.to_vec();
                            break;
                        }
                    }
                }
            }
        }
        output
    }

    /// Flushes bytes left over when the stream ends.
    fn finish(&mut self) -> String {
        let pending = std::mem::take(&mut self.pending);
        String::from_utf8_lossy(&pending).into_owned()
    }
}

/// Lets a session's output reader emit events only while the session is still
/// registered. `close` deactivates the gate while holding its lock, so once it
/// returns a superseded reader can no longer emit `terminal-output` or
/// `terminal-exited` under a session id that a fresh session now owns.
#[derive(Debug)]
struct OutputGate {
    active: Mutex<bool>,
}

impl OutputGate {
    fn new() -> Self {
        Self {
            active: Mutex::new(true),
        }
    }

    fn emit_if_active(&self, emit: impl FnOnce()) -> bool {
        let active = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *active {
            emit();
        }
        *active
    }

    fn deactivate(&self) {
        *self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = false;
    }
}

enum ReaderEvent {
    Output(TerminalOutput),
    Exited,
}

/// Reads PTY output until EOF, recording it in the session history and
/// passing each event to `emit` while the gate is active.
fn run_output_reader(
    session_id: &str,
    reader: &mut dyn Read,
    output_history: &Mutex<TerminalOutputHistory>,
    gate: &OutputGate,
    mut emit: impl FnMut(ReaderEvent),
) {
    let mut buffer = [0_u8; 8192];
    let mut decoder = Utf8ChunkDecoder::default();
    let mut emit_output = |data: String| {
        if data.is_empty() {
            return;
        }
        gate.emit_if_active(|| {
            let event = output_history
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .append(session_id.to_owned(), data);
            emit(ReaderEvent::Output(event));
        });
    };
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(length) => emit_output(decoder.decode(&buffer[..length])),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    emit_output(decoder.finish());
    drop(emit_output);
    gate.emit_if_active(|| emit(ReaderEvent::Exited));
}

fn spawn_output_reader(
    app: AppHandle,
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    output_history: Arc<Mutex<TerminalOutputHistory>>,
    gate: Arc<OutputGate>,
) -> Result<(), String> {
    thread::Builder::new()
        .name(format!("pty-output-{session_id}"))
        .spawn(move || {
            run_output_reader(
                &session_id,
                reader.as_mut(),
                &output_history,
                &gate,
                |event| match event {
                    ReaderEvent::Output(event) => {
                        let _ = app.emit("terminal-output", event);
                    }
                    ReaderEvent::Exited => {
                        let _ = app.emit("terminal-exited", session_id.clone());
                    }
                },
            );
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

    #[derive(Debug)]
    struct FakeChild {
        exited: bool,
    }

    impl portable_pty::ChildKiller for FakeChild {
        fn kill(&mut self) -> std::io::Result<()> {
            self.exited = true;
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(FakeChild {
                exited: self.exited,
            })
        }
    }

    impl Child for FakeChild {
        fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
            Ok(self
                .exited
                .then(|| portable_pty::ExitStatus::with_exit_code(0)))
        }

        fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
            self.exited = true;
            Ok(portable_pty::ExitStatus::with_exit_code(0))
        }

        fn process_id(&self) -> Option<u32> {
            None
        }

        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }

    /// A session backed by a real (child-less) PTY and a fake child process,
    /// so lifecycle logic can be tested without an AppHandle.
    fn fake_session(exited: bool) -> Arc<TerminalSession> {
        let pair = native_pty_system()
            .openpty(PtySize::default())
            .expect("open test pty");
        let writer = pair.master.take_writer().expect("take test pty writer");
        Arc::new(TerminalSession {
            process_id: None,
            process_start_time: None,
            shell: "Fake".to_owned(),
            working_directory: "fake-cwd".to_owned(),
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(Box::new(FakeChild { exited })),
            output_history: Arc::new(Mutex::new(TerminalOutputHistory::default())),
            output_gate: Arc::new(OutputGate::new()),
        })
    }

    fn collect_reader_events(reader: &mut dyn Read, gate: &OutputGate) -> Vec<String> {
        let history = Mutex::new(TerminalOutputHistory::default());
        let mut events = Vec::new();
        run_output_reader("s1", reader, &history, gate, |event| {
            events.push(match event {
                ReaderEvent::Output(output) => format!("output:{}", output.data),
                ReaderEvent::Exited => "exited".to_owned(),
            })
        });
        events
    }

    /// Yields one chunk, then runs `on_second_read` (simulating `close`
    /// happening while the reader is blocked) and yields a trailing chunk.
    struct InterleavedReader<F: FnMut()> {
        reads: usize,
        on_second_read: F,
    }

    impl<F: FnMut()> Read for InterleavedReader<F> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.reads += 1;
            let chunk: &[u8] = match self.reads {
                1 => b"before",
                2 => {
                    (self.on_second_read)();
                    b"after"
                }
                _ => b"",
            };
            buffer[..chunk.len()].copy_from_slice(chunk);
            Ok(chunk.len())
        }
    }

    #[test]
    fn output_reader_emits_output_then_exit_while_active() {
        let gate = OutputGate::new();
        let events = collect_reader_events(&mut std::io::Cursor::new(b"hi".to_vec()), &gate);
        assert_eq!(events, vec!["output:hi".to_owned(), "exited".to_owned()]);
    }

    #[test]
    fn superseded_reader_does_not_emit_after_its_session_is_closed() {
        let mut manager = SessionManager::default();
        let dead = fake_session(true);
        let gate = Arc::clone(&dead.output_gate);
        manager.sessions.insert("s1".to_owned(), dead);
        assert!(manager.existing_info("s1").is_none(), "exited session is reaped");

        // Trailing output and the exit notification of the reaped session
        // must not reach a new session that reuses the id.
        let events = collect_reader_events(&mut std::io::Cursor::new(b"late".to_vec()), &gate);
        assert!(events.is_empty(), "{events:?}");

        // Closing while the reader is blocked mid-stream stops later events.
        let live = fake_session(false);
        let gate = Arc::clone(&live.output_gate);
        let manager = Mutex::new(SessionManager::default());
        manager
            .lock()
            .unwrap()
            .sessions
            .insert("s1".to_owned(), live);
        let mut reader = InterleavedReader {
            reads: 0,
            on_second_read: || {
                manager.lock().unwrap().close("s1").expect("close session");
            },
        };
        let events = collect_reader_events(&mut reader, &gate);
        assert_eq!(events, vec!["output:before".to_owned()]);
    }

    #[test]
    fn existing_info_reaps_exited_sessions_and_keeps_running_ones() {
        let mut manager = SessionManager::default();
        manager
            .sessions
            .insert("dead".to_owned(), fake_session(true));
        manager
            .sessions
            .insert("live".to_owned(), fake_session(false));

        assert!(
            manager.existing_info("dead").is_none(),
            "an exited session must not be reused"
        );
        assert!(!manager.sessions.contains_key("dead"));

        let live = manager.existing_info("live").expect("running session is reused");
        assert_eq!(live.shell, "Fake");
        assert_eq!(live.working_directory, "fake-cwd");
        assert!(manager.sessions.contains_key("live"));
        assert!(manager.existing_info("missing").is_none());

        manager.close("live").expect("close running session");
        assert!(manager.sessions.is_empty());
    }

    #[test]
    fn input_handle_writes_without_borrowing_the_manager() {
        let mut manager = SessionManager::default();
        manager
            .sessions
            .insert("live".to_owned(), fake_session(false));

        let input = manager.input("live").expect("input handle");
        // The handle stays usable after the manager (and its lock) is gone.
        drop(manager);
        input.write("echo hi\r").expect("write to pty");
        let error = input.write(&"a".repeat(MAX_TERMINAL_INPUT_BYTES + 1)).unwrap_err();
        assert!(error.contains("too large"), "{error}");
    }

    fn root(
        session_id: &str,
        process_id: Option<u32>,
        process_start_time: Option<u64>,
        running: bool,
    ) -> TerminalProcessRoot {
        TerminalProcessRoot {
            session_id: session_id.to_owned(),
            process_id,
            process_start_time,
            running,
        }
    }

    #[test]
    fn resource_monitor_reports_unavailable_roots() {
        let mut monitor = TerminalResourceMonitor::default();
        let pid = std::process::id();
        let start = read_process_start_time(pid);
        let usage = monitor.collect(vec![
            root("no-pid", None, Some(1), true),
            root("no-start", Some(pid), None, true),
            root("exited", Some(pid), start, false),
            root("reused-pid", Some(pid), start.map(|time| time + 1), true),
        ]);

        let ids: Vec<&str> = usage.iter().map(|item| item.session_id.as_str()).collect();
        assert_eq!(ids, vec!["no-pid", "no-start", "exited", "reused-pid"]);
        for item in &usage {
            assert!(!item.available, "{} should be unavailable", item.session_id);
            assert_eq!(item.process_count, 0);
            assert_eq!(item.memory_bytes, 0);
            assert_eq!(item.cpu_percent, None);
        }
    }

    #[test]
    fn resource_monitor_measures_the_current_process() {
        let mut monitor = TerminalResourceMonitor::default();
        if monitor.metrics_system.is_none() {
            eprintln!("skipping: process metrics are unavailable on this platform");
            return;
        }
        let pid = std::process::id();
        let start = read_process_start_time(pid).expect("current process start time");

        let first = monitor.collect(vec![root("self", Some(pid), Some(start), true)]);
        assert_eq!(first.len(), 1);
        assert!(first[0].available);
        assert!(first[0].process_count >= 1);
        assert!(first[0].memory_bytes > 0);
        // CPU needs two samples of the same process set.
        assert_eq!(first[0].cpu_percent, None);

        // Other tests may briefly spawn child processes (which resets CPU
        // readiness), so allow a few samples for a stable process set.
        let cpu = (0..5)
            .find_map(|_| {
                let sample = monitor.collect(vec![root("self", Some(pid), Some(start), true)]);
                assert!(sample[0].available);
                sample[0].cpu_percent
            })
            .expect("cpu after repeated samples");
        assert!((0.0..=100.0).contains(&cpu), "{cpu}");
    }

    fn decode_in_chunks(bytes: &[u8], split_at: &[usize]) -> String {
        let mut decoder = Utf8ChunkDecoder::default();
        let mut output = String::new();
        let mut start = 0;
        for &end in split_at.iter().chain(std::iter::once(&bytes.len())) {
            output.push_str(&decoder.decode(&bytes[start..end]));
            start = end;
        }
        output.push_str(&decoder.finish());
        output
    }

    #[test]
    fn utf8_decoder_joins_characters_split_across_chunks() {
        let text = "aş ğ 🚀 ü";
        let bytes = text.as_bytes();
        // Every possible single split point, including inside each multi-byte char.
        for split in 0..=bytes.len() {
            assert_eq!(decode_in_chunks(bytes, &[split]), text, "split at {split}");
        }
        // The 4-byte emoji delivered one byte per read.
        let emoji = "🚀".as_bytes();
        assert_eq!(decode_in_chunks(emoji, &[1, 2, 3]), "🚀");

        let mut decoder = Utf8ChunkDecoder::default();
        assert_eq!(decoder.decode(&"ş".as_bytes()[..1]), "");
        assert_eq!(decoder.decode(&"ş".as_bytes()[1..]), "ş");
    }

    #[test]
    fn utf8_decoder_replaces_invalid_and_truncated_bytes() {
        // A lone continuation byte and an invalid lead are replaced in place.
        assert_eq!(decode_in_chunks(b"a\x80b\xFFc", &[]), "a\u{FFFD}b\u{FFFD}c");
        // An invalid byte after a carried prefix does not swallow the next char.
        assert_eq!(decode_in_chunks(b"x\xC5", &[]), "x\u{FFFD}");
        assert_eq!(
            decode_in_chunks(&[b'x', 0xC5, b'y'], &[2]),
            "x\u{FFFD}y"
        );
        // A stream ending mid-character flushes a replacement on finish.
        let mut decoder = Utf8ChunkDecoder::default();
        assert_eq!(decoder.decode(&"ğ".as_bytes()[..1]), "");
        assert_eq!(decoder.finish(), "\u{FFFD}");
        assert_eq!(decoder.finish(), "");
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

    #[cfg(windows)]
    #[test]
    fn resolve_program_prefers_pathext_shims_over_extensionless_files() {
        let dir = tempfile::tempdir().expect("create temp directory");
        // npm installs an extensionless POSIX shell shim next to `tool.cmd`;
        // CreateProcess cannot start the extensionless one.
        fs::write(dir.path().join("tool"), "#!/bin/sh\n").expect("write shim");
        fs::write(dir.path().join("tool.cmd"), "@echo off\n").expect("write cmd shim");
        let search_path = std::env::join_paths([dir.path()]).expect("join search path");

        let resolved = resolve_program_in("tool", Some(&search_path), Some(".COM;.EXE;.BAT;.CMD"))
            .expect("resolve tool");
        assert!(
            resolved.to_ascii_lowercase().ends_with("tool.cmd"),
            "{resolved}"
        );

        // PATHEXT order wins; script-host extensions CreateProcess cannot run
        // are skipped, and the bare name is the last resort.
        fs::write(dir.path().join("tool.exe"), "").expect("write exe");
        fs::write(dir.path().join("tool.js"), "").expect("write js");
        let resolved = resolve_program_in("tool", Some(&search_path), Some(".JS;.EXE;.CMD"))
            .expect("resolve tool");
        assert!(
            resolved.to_ascii_lowercase().ends_with("tool.exe"),
            "{resolved}"
        );
        let resolved = resolve_program_in("tool", Some(&search_path), None).expect("default");
        assert!(
            resolved.to_ascii_lowercase().ends_with("tool.exe"),
            "{resolved}"
        );

        fs::write(dir.path().join("plain"), "").expect("write plain");
        let resolved =
            resolve_program_in("plain", Some(&search_path), Some(".EXE")).expect("bare fallback");
        assert!(resolved.ends_with("plain"), "{resolved}");
        let explicit =
            resolve_program_in("tool.cmd", Some(&search_path), Some(".EXE")).expect("explicit");
        assert!(explicit.ends_with("tool.cmd"), "{explicit}");
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
