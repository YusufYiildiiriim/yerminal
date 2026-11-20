//! Local AI agent usage (Codex CLI, Claude Code).
//!
//! Reads only the agents' local JSONL logs. Each file keeps a byte offset in
//! memory so later calls parse just the new complete lines. Only numeric
//! summaries leave this module: no message text, working directories or
//! project names. Nothing is persisted and nothing is sent over the network.

use chrono::{DateTime, FixedOffset, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const WINDOW_DAYS: i64 = 7;
const DAY_MS: i64 = 86_400_000;
const MAX_DEPTH: usize = 8;
const TAIL_CHUNK: u64 = 64 * 1024;
const TAIL_MAX_BYTES: u64 = 8 * 1024 * 1024;
const TAIL_CANDIDATES: usize = 3;
const READ_ERROR: &str = "Could not read usage logs";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenTotals {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total: u64,
}

impl TokenTotals {
    fn add(&mut self, other: &TokenTotals) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.total += other.total;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodexTotals {
    pub input: u64,
    pub output: u64,
    pub cached: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CodexRateWindow {
    pub used_percent: f64,
    pub window_minutes: u64,
    pub resets_at: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CodexRate {
    pub primary: Option<CodexRateWindow>,
    pub secondary: Option<CodexRateWindow>,
    pub plan_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CodexEvent {
    pub at: DateTime<FixedOffset>,
    pub totals: Option<CodexTotals>,
    pub rate: Option<CodexRate>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeEvent {
    pub message_id: Option<String>,
    pub at: DateTime<FixedOffset>,
    pub model: String,
    pub tokens: TokenTotals,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeEntry {
    pub day: NaiveDate,
    pub model: String,
    pub tokens: TokenTotals,
}

impl ClaudeEntry {
    /// Streaming logs repeat one message with growing usage; keep the largest value per field.
    pub fn absorb(&mut self, other: &ClaudeEntry) {
        let (mine, theirs) = (&mut self.tokens, other.tokens);
        mine.input = mine.input.max(theirs.input);
        mine.output = mine.output.max(theirs.output);
        mine.cache_read = mine.cache_read.max(theirs.cache_read);
        mine.cache_write = mine.cache_write.max(theirs.cache_write);
        mine.total = mine.total.max(theirs.total);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Codex,
    Claude,
}

#[derive(Debug, Default)]
pub struct CodexFileUsage {
    pub prev: Option<CodexTotals>,
    pub daily: BTreeMap<NaiveDate, TokenTotals>,
}

impl CodexFileUsage {
    /// `total_token_usage` is cumulative per session; the day's usage is the delta
    /// attributed to the day of the event. A decrease means a counter reset.
    pub fn apply<Tz: TimeZone>(&mut self, event: &CodexEvent, tz: &Tz) {
        let Some(current) = event.totals else { return };
        let delta = match self.prev {
            Some(prev) if current.total >= prev.total => CodexTotals {
                input: current.input.saturating_sub(prev.input),
                output: current.output.saturating_sub(prev.output),
                cached: current.cached.saturating_sub(prev.cached),
                total: current.total - prev.total,
            },
            _ => current,
        };
        self.prev = Some(current);
        let day = event.at.with_timezone(tz).date_naive();
        let entry = self.daily.entry(day).or_default();
        entry.input += delta.input;
        entry.output += delta.output;
        entry.cache_read += delta.cached;
        entry.total += delta.total;
    }
}

#[derive(Debug, Default)]
pub struct TrackedFile {
    pub offset: u64,
    pub codex: CodexFileUsage,
    pub claude_by_id: HashMap<String, ClaudeEntry>,
    pub claude_anonymous: Vec<ClaudeEntry>,
}

impl TrackedFile {
    pub fn ingest_line<Tz: TimeZone>(&mut self, source: Source, line: &str, tz: &Tz) {
        match source {
            Source::Codex => {
                if !line.contains("token_count") {
                    return;
                }
                if let Some(event) = parse_codex_line(line) {
                    self.codex.apply(&event, tz);
                }
            }
            Source::Claude => {
                if !line.contains("\"usage\"") {
                    return;
                }
                let Some(event) = parse_claude_line(line) else { return };
                let entry = ClaudeEntry {
                    day: event.at.with_timezone(tz).date_naive(),
                    model: event.model,
                    tokens: event.tokens,
                };
                match event.message_id {
                    Some(id) => {
                        self.claude_by_id
                            .entry(id)
                            .and_modify(|existing| existing.absorb(&entry))
                            .or_insert(entry);
                    }
                    None => self.claude_anonymous.push(entry),
                }
            }
        }
    }
}

#[derive(Debug, Default)]
pub struct AgentUsageCache {
    pub files: HashMap<PathBuf, TrackedFile>,
    pub rate_tails: HashMap<PathBuf, (u64, Option<CodexEvent>)>,
    pub opens: u64,
}

#[derive(Debug, Clone)]
pub struct UsageRoots {
    pub codex: Vec<PathBuf>,
    pub claude: PathBuf,
}

impl UsageRoots {
    pub fn from_home(home: &Path) -> Self {
        Self {
            codex: vec![
                home.join(".codex").join("sessions"),
                home.join(".codex").join("archived_sessions"),
            ],
            claude: home.join(".claude").join("projects"),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    pub remaining_percent: f64,
    pub window_minutes: u64,
    pub resets_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LimitSnapshot {
    pub primary: Option<LimitWindow>,
    pub secondary: Option<LimitWindow>,
    pub observed_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub id: String,
    pub name: String,
    pub supported: bool,
    pub available: bool,
    pub limits_supported: bool,
    pub limits: Option<LimitSnapshot>,
    pub plan_type: Option<String>,
    pub today: TokenTotals,
    pub week: TokenTotals,
    pub models: Vec<ModelUsage>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageSnapshot {
    pub status: String,
    pub generated_at_ms: i64,
    pub agents: Vec<AgentUsage>,
}

// Only the fields we need. Unknown fields (text, cwd, ids) are skipped by serde.
#[derive(Deserialize)]
struct CodexEnvelope {
    timestamp: Option<String>,
    payload: Option<CodexPayload>,
}

#[derive(Deserialize)]
struct CodexPayload {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    info: Option<CodexInfo>,
    #[serde(default)]
    rate_limits: Option<CodexRateRaw>,
}

#[derive(Deserialize)]
struct CodexInfo {
    #[serde(default)]
    total_token_usage: Option<CodexUsageRaw>,
}

#[derive(Deserialize)]
struct CodexUsageRaw {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

#[derive(Deserialize)]
struct CodexRateRaw {
    primary: Option<CodexWindowRaw>,
    secondary: Option<CodexWindowRaw>,
    plan_type: Option<String>,
}

#[derive(Deserialize)]
struct CodexWindowRaw {
    used_percent: Option<f64>,
    window_minutes: Option<f64>,
    resets_at: Option<f64>,
}

#[derive(Deserialize)]
struct ClaudeEnvelope {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    message: Option<ClaudeMessage>,
}

#[derive(Deserialize)]
struct ClaudeMessage {
    id: Option<String>,
    model: Option<String>,
    usage: Option<ClaudeUsageRaw>,
}

#[derive(Deserialize)]
struct ClaudeUsageRaw {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
}

fn window_from_raw(raw: CodexWindowRaw) -> Option<CodexRateWindow> {
    Some(CodexRateWindow {
        used_percent: raw.used_percent?,
        window_minutes: raw.window_minutes? as u64,
        resets_at: raw.resets_at? as i64,
    })
}

pub fn parse_codex_line(line: &str) -> Option<CodexEvent> {
    if !line.contains("token_count") {
        return None;
    }
    let envelope: CodexEnvelope = serde_json::from_str(line).ok()?;
    let payload = envelope.payload?;
    if payload.kind.as_deref() != Some("token_count") {
        return None;
    }
    let at = DateTime::parse_from_rfc3339(envelope.timestamp.as_deref()?).ok()?;
    let totals = payload
        .info
        .and_then(|info| info.total_token_usage)
        .map(|usage| {
            let input = usage.input_tokens.unwrap_or(0);
            let output = usage.output_tokens.unwrap_or(0);
            CodexTotals {
                input,
                output,
                cached: usage.cached_input_tokens.unwrap_or(0),
                total: usage.total_tokens.unwrap_or(input + output),
            }
        });
    let rate = payload.rate_limits.and_then(|raw| {
        let primary = raw.primary.and_then(window_from_raw);
        let secondary = raw.secondary.and_then(window_from_raw);
        (primary.is_some() || secondary.is_some()).then_some(CodexRate {
            primary,
            secondary,
            plan_type: raw.plan_type,
        })
    });
    Some(CodexEvent { at, totals, rate })
}

pub fn parse_claude_line(line: &str) -> Option<ClaudeEvent> {
    if !line.contains("\"usage\"") {
        return None;
    }
    let envelope: ClaudeEnvelope = serde_json::from_str(line).ok()?;
    if envelope.kind.as_deref() != Some("assistant") {
        return None;
    }
    let message = envelope.message?;
    let usage = message.usage?;
    let at = DateTime::parse_from_rfc3339(envelope.timestamp.as_deref()?).ok()?;
    let input = usage.input_tokens.unwrap_or(0);
    let output = usage.output_tokens.unwrap_or(0);
    let cache_read = usage.cache_read_input_tokens.unwrap_or(0);
    let cache_write = usage.cache_creation_input_tokens.unwrap_or(0);
    Some(ClaudeEvent {
        message_id: message.id,
        at,
        model: message.model.unwrap_or_else(|| "unknown".to_owned()),
        tokens: TokenTotals {
            input,
            output,
            cache_read,
            cache_write,
            total: input + output + cache_read + cache_write,
        },
    })
}

/// Reads complete lines appended since the last call. A trailing line without
/// a newline is left for the next call, so a half-written record is never parsed.
pub fn sync_file<Tz: TimeZone>(
    cache: &mut AgentUsageCache,
    path: &Path,
    source: Source,
    tz: &Tz,
) -> io::Result<()> {
    let len = fs::metadata(path)?.len();
    if cache.files.get(path).is_some_and(|file| len < file.offset) {
        cache.files.remove(path);
    }
    let offset = cache.files.get(path).map_or(0, |file| file.offset);
    if len <= offset {
        return Ok(());
    }

    cache.opens += 1;
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut reader = BufReader::new(file);
    let entry = cache.files.entry(path.to_path_buf()).or_default();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let read = reader.read_until(b'\n', &mut buf)?;
        if read == 0 || buf.last() != Some(&b'\n') {
            break;
        }
        entry.offset += read as u64;
        if let Ok(text) = std::str::from_utf8(&buf) {
            entry.ingest_line(source, text.trim_end(), tz);
        }
    }
    Ok(())
}

fn rate_event_in(bytes: &[u8]) -> Option<CodexEvent> {
    if !bytes.windows(11).any(|window| window == b"rate_limits") {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    parse_codex_line(text).filter(|event| event.rate.is_some())
}

/// Scans backwards from the end of a file in `chunk`-sized reads and returns the
/// newest token_count event that carries rate limits. Stops after `max_bytes`.
pub fn last_rate_in_file(path: &Path, chunk: u64, max_bytes: u64) -> io::Result<Option<CodexEvent>> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let chunk = chunk.max(1);
    let mut end = size;
    let mut budget = max_bytes;
    // Bytes after the first newline of the block read before this one. They
    // belong to the line that starts inside the next (earlier) block.
    let mut carry: Vec<u8> = Vec::new();

    while end > 0 && budget > 0 {
        let step = chunk.min(end).min(budget);
        let start = end - step;
        file.seek(SeekFrom::Start(start))?;
        let mut combined = vec![0u8; step as usize];
        file.read_exact(&mut combined)?;
        combined.extend_from_slice(&carry);
        budget -= step;

        let mut pieces: Vec<&[u8]> = combined.split(|byte| *byte == b'\n').collect();
        let head = pieces.remove(0).to_vec();
        for piece in pieces.iter().rev() {
            if let Some(event) = rate_event_in(piece) {
                return Ok(Some(event));
            }
        }
        carry = head;
        end = start;
    }

    if end == 0 {
        return Ok(rate_event_in(&carry));
    }
    Ok(None)
}

#[derive(Debug, Clone)]
struct Candidate {
    path: PathBuf,
    size: u64,
    mtime_ms: i64,
}

fn system_time_ms(time: std::time::SystemTime) -> i64 {
    time.duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Recursively lists `.jsonl` files whose mtime is inside the window. Older
/// files are skipped before they are opened.
fn collect_jsonl(dir: &Path, accept: fn(&str) -> bool, cutoff_ms: i64, depth: usize, out: &mut Vec<Candidate>) -> io::Result<()> {
    if depth > MAX_DEPTH {
        return Ok(());
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            let _ = collect_jsonl(&path, accept, cutoff_ms, depth + 1, out);
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !file_type.is_file() || !name.ends_with(".jsonl") || !accept(name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let mtime_ms = meta.modified().map(system_time_ms).unwrap_or(0);
        if mtime_ms < cutoff_ms {
            continue;
        }
        out.push(Candidate { path, size: meta.len(), mtime_ms });
    }
    Ok(())
}

fn is_codex_name(name: &str) -> bool {
    name.starts_with("rollout-")
}

fn accept_any(_: &str) -> bool {
    true
}

fn cached_rate_tail(cache: &mut AgentUsageCache, path: &Path, size: u64) -> Option<CodexEvent> {
    if let Some((seen_size, event)) = cache.rate_tails.get(path) {
        if *seen_size == size {
            return event.clone();
        }
    }
    let event = last_rate_in_file(path, TAIL_CHUNK, TAIL_MAX_BYTES).ok().flatten();
    cache.rate_tails.insert(path.to_path_buf(), (size, event.clone()));
    event
}

fn remaining_window(window: CodexRateWindow) -> LimitWindow {
    LimitWindow {
        remaining_percent: (100.0 - window.used_percent).clamp(0.0, 100.0),
        window_minutes: window.window_minutes,
        resets_at_ms: window.resets_at.saturating_mul(1000),
    }
}

fn empty_agent(id: &str, name: &str, supported: bool) -> AgentUsage {
    AgentUsage {
        id: id.to_owned(),
        name: name.to_owned(),
        supported,
        available: false,
        limits_supported: false,
        limits: None,
        plan_type: None,
        today: TokenTotals::default(),
        week: TokenTotals::default(),
        models: Vec::new(),
        error: None,
    }
}

pub fn collect<Tz: TimeZone>(
    cache: &mut AgentUsageCache,
    roots: &UsageRoots,
    now: DateTime<Tz>,
) -> AgentUsageSnapshot {
    let tz = now.timezone();
    let today = now.date_naive();
    let week_start = today - chrono::Duration::days(WINDOW_DAYS - 1);
    let cutoff_ms = now.timestamp_millis() - WINDOW_DAYS * DAY_MS;
    let in_window = |day: NaiveDate| day >= week_start && day <= today;

    let mut codex_files = Vec::new();
    let mut codex_error = false;
    for root in &roots.codex {
        if collect_jsonl(root, is_codex_name, cutoff_ms, 0, &mut codex_files).is_err() {
            codex_error = true;
        }
    }
    let mut claude_files = Vec::new();
    let claude_error = collect_jsonl(&roots.claude, accept_any, cutoff_ms, 0, &mut claude_files).is_err();

    let keep: HashSet<PathBuf> = codex_files.iter().chain(claude_files.iter()).map(|c| c.path.clone()).collect();
    cache.files.retain(|path, _| keep.contains(path));
    cache.rate_tails.retain(|path, _| keep.contains(path));

    for candidate in &codex_files {
        if sync_file(cache, &candidate.path, Source::Codex, &tz).is_err() {
            codex_error = true;
        }
    }
    let mut claude_error = claude_error;
    for candidate in &claude_files {
        if sync_file(cache, &candidate.path, Source::Claude, &tz).is_err() {
            claude_error = true;
        }
    }

    // Codex: daily totals from cached deltas; limits from the newest few files.
    let mut codex = empty_agent("codex", "Codex CLI", true);
    codex.limits_supported = true;
    codex.available = roots.codex.iter().any(|root| root.is_dir());
    for candidate in &codex_files {
        if let Some(file) = cache.files.get(&candidate.path) {
            for (day, totals) in file.codex.daily.range(week_start..=today) {
                codex.week.add(totals);
                if *day == today {
                    codex.today.add(totals);
                }
            }
        }
    }
    let mut newest = codex_files.clone();
    newest.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    let mut best: Option<CodexEvent> = None;
    for candidate in newest.iter().take(TAIL_CANDIDATES) {
        if let Some(event) = cached_rate_tail(cache, &candidate.path, candidate.size) {
            if best.as_ref().map_or(true, |current| event.at > current.at) {
                best = Some(event);
            }
        }
    }
    if let Some(event) = best {
        if let Some(rate) = event.rate {
            codex.plan_type = rate.plan_type.clone();
            codex.limits = Some(LimitSnapshot {
                primary: rate.primary.map(remaining_window),
                secondary: rate.secondary.map(remaining_window),
                observed_at_ms: event.at.timestamp_millis(),
            });
        }
    }
    codex.error = codex_error.then(|| READ_ERROR.to_owned());

    // Claude: dedupe by message id across files, then sum the window.
    let mut claude = empty_agent("claude", "Claude Code", true);
    claude.available = roots.claude.is_dir();
    let mut merged: HashMap<&str, ClaudeEntry> = HashMap::new();
    let mut anonymous: Vec<&ClaudeEntry> = Vec::new();
    for candidate in &claude_files {
        if let Some(file) = cache.files.get(&candidate.path) {
            for (id, entry) in &file.claude_by_id {
                if !in_window(entry.day) {
                    continue;
                }
                merged
                    .entry(id.as_str())
                    .and_modify(|existing| existing.absorb(entry))
                    .or_insert_with(|| entry.clone());
            }
            anonymous.extend(file.claude_anonymous.iter().filter(|entry| in_window(entry.day)));
        }
    }
    let mut by_model: BTreeMap<String, u64> = BTreeMap::new();
    for entry in merged.values().chain(anonymous.into_iter()) {
        claude.week.add(&entry.tokens);
        if entry.day == today {
            claude.today.add(&entry.tokens);
        }
        *by_model.entry(entry.model.clone()).or_insert(0) += entry.tokens.total;
    }
    let mut models: Vec<ModelUsage> = by_model
        .into_iter()
        .map(|(model, total)| ModelUsage { model, total })
        .collect();
    models.sort_by(|a, b| b.total.cmp(&a.total).then_with(|| a.model.cmp(&b.model)));
    claude.models = models;
    claude.error = claude_error.then(|| READ_ERROR.to_owned());

    AgentUsageSnapshot {
        status: "ok".to_owned(),
        generated_at_ms: now.timestamp_millis(),
        agents: vec![
            codex,
            claude,
            empty_agent("agy", "Antigravity (agy)", false),
            empty_agent("custom", "Custom agents (agents.toml)", false),
        ],
    }
}

pub fn snapshot_with<Tz: TimeZone>(
    cache: &Mutex<AgentUsageCache>,
    enabled: bool,
    roots: &UsageRoots,
    now: DateTime<Tz>,
) -> Result<AgentUsageSnapshot, String> {
    if !enabled {
        return Ok(AgentUsageSnapshot {
            status: "disabled".to_owned(),
            generated_at_ms: now.timestamp_millis(),
            agents: Vec::new(),
        });
    }
    let mut guard = cache
        .lock()
        .map_err(|_| "Agent usage cache is unavailable".to_owned())?;
    Ok(collect(&mut guard, roots, now))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, NaiveDate, Utc};
    use std::fs::{self, OpenOptions};
    use std::io::Write;

    const CODEX_TOKEN_LINE: &str = r#"{"timestamp":"2026-11-20T10:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":200,"reasoning_output_tokens":50,"total_tokens":1200}},"rate_limits":{"primary":{"used_percent":25.0,"window_minutes":300,"resets_at":1763632800},"secondary":{"used_percent":40.5,"window_minutes":10080,"resets_at":1764000000},"plan_type":"plus"}}}"#;

    const CLAUDE_ASSISTANT_LINE: &str = r#"{"type":"assistant","timestamp":"2026-11-20T09:00:00.000Z","cwd":"/synthetic/project","message":{"id":"msg_A","model":"claude-sonnet-x","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":20}}}"#;

    fn day(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    fn codex_line(at: DateTime<Utc>, total: u64) -> String {
        format!(
            r#"{{"timestamp":"{}","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{t},"cached_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0,"total_tokens":{t}}}}}}}}}"#,
            at.to_rfc3339(),
            t = total
        )
    }

    fn codex_rate_line(at: DateTime<Utc>, used: f64) -> String {
        format!(
            r#"{{"timestamp":"{}","type":"event_msg","payload":{{"type":"token_count","info":null,"rate_limits":{{"primary":{{"used_percent":{used},"window_minutes":300,"resets_at":1763632800}},"secondary":null,"plan_type":"plus"}}}}}}"#,
            at.to_rfc3339(),
            used = used
        )
    }

    fn claude_line(at: DateTime<Utc>, id: &str, model: &str, input: u64, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{}","message":{{"id":"{}","model":"{}","usage":{{"input_tokens":{},"output_tokens":{},"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#,
            at.to_rfc3339(),
            id,
            model,
            input,
            output
        )
    }

    fn append(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = OpenOptions::new().create(true).append(true).open(path).unwrap();
        file.write_all(text.as_bytes()).unwrap();
    }

    fn event(ts: &str, total: u64) -> CodexEvent {
        CodexEvent {
            at: DateTime::parse_from_rfc3339(ts).unwrap(),
            totals: Some(CodexTotals { input: total, output: 0, cached: 0, total }),
            rate: None,
        }
    }

    #[test]
    fn codex_token_count_line_yields_totals_and_rate_limits() {
        let event = parse_codex_line(CODEX_TOKEN_LINE).expect("token_count line");
        assert_eq!(event.totals, Some(CodexTotals { input: 1000, output: 200, cached: 400, total: 1200 }));
        let rate = event.rate.expect("rate limits");
        assert_eq!(rate.plan_type.as_deref(), Some("plus"));
        assert_eq!(
            rate.primary,
            Some(CodexRateWindow { used_percent: 25.0, window_minutes: 300, resets_at: 1763632800 })
        );
        assert_eq!(rate.secondary.map(|window| window.window_minutes), Some(10080));
    }

    #[test]
    fn codex_parser_ignores_other_events_and_broken_lines() {
        let text_only = r#"{"timestamp":"2026-11-20T10:00:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"token_count is only text"}}"#;
        assert!(parse_codex_line(text_only).is_none());
        assert!(parse_codex_line("not json at all").is_none());
    }

    #[test]
    fn codex_daily_totals_use_cumulative_deltas_attributed_to_event_day() {
        let mut usage = CodexFileUsage::default();
        usage.apply(&event("2026-11-19T23:00:00Z", 100), &Utc);
        usage.apply(&event("2026-11-20T09:00:00Z", 250), &Utc);
        usage.apply(&event("2026-11-20T10:00:00Z", 260), &Utc);
        assert_eq!(usage.daily[&day(2026, 11, 19)].total, 100);
        assert_eq!(usage.daily[&day(2026, 11, 20)].total, 160);
    }

    #[test]
    fn codex_counter_reset_starts_a_new_baseline() {
        let mut usage = CodexFileUsage::default();
        usage.apply(&event("2026-11-20T09:00:00Z", 260), &Utc);
        usage.apply(&event("2026-11-20T10:00:00Z", 40), &Utc);
        assert_eq!(usage.daily[&day(2026, 11, 20)].total, 300);
    }

    #[test]
    fn claude_assistant_line_yields_model_message_id_and_all_token_kinds() {
        let event = parse_claude_line(CLAUDE_ASSISTANT_LINE).expect("assistant usage line");
        assert_eq!(event.message_id.as_deref(), Some("msg_A"));
        assert_eq!(event.model, "claude-sonnet-x");
        assert_eq!(
            event.tokens,
            TokenTotals { input: 10, output: 5, cache_read: 100, cache_write: 20, total: 135 }
        );
    }

    #[test]
    fn claude_parser_skips_user_lines_and_assistant_lines_without_usage() {
        let user = r#"{"type":"user","timestamp":"2026-11-20T09:00:00.000Z","message":{"role":"user","content":"hi"}}"#;
        let no_usage = r#"{"type":"assistant","timestamp":"2026-11-20T09:00:00.000Z","message":{"id":"m","content":[]}}"#;
        assert!(parse_claude_line(user).is_none());
        assert!(parse_claude_line(no_usage).is_none());
    }

    #[test]
    fn streaming_duplicates_of_one_message_keep_the_largest_usage() {
        let tokens = |output| TokenTotals { input: 10, output, cache_read: 0, cache_write: 0, total: 10 + output };
        let mut entry = ClaudeEntry { day: day(2026, 11, 20), model: "m".into(), tokens: tokens(5) };
        entry.absorb(&ClaudeEntry { day: day(2026, 11, 20), model: "m".into(), tokens: tokens(12) });
        entry.absorb(&ClaudeEntry { day: day(2026, 11, 20), model: "m".into(), tokens: tokens(7) });
        assert_eq!(entry.tokens.output, 12);
        assert_eq!(entry.tokens.total, 22);
    }

    #[test]
    fn repeated_claude_message_id_in_one_file_is_counted_once() {
        let mut file = TrackedFile::default();
        file.ingest_line(Source::Claude, CLAUDE_ASSISTANT_LINE, &Utc);
        file.ingest_line(Source::Claude, CLAUDE_ASSISTANT_LINE, &Utc);
        assert_eq!(file.claude_by_id.len(), 1);
        assert!(file.claude_anonymous.is_empty());
        assert_eq!(file.claude_by_id["msg_A"].tokens.total, 135);
    }

    #[test]
    fn sync_reads_only_new_complete_lines_and_waits_for_a_partial_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout-a.jsonl");
        let now = Utc::now();
        let first = codex_line(now, 100);
        let second = codex_line(now, 250);
        let (head, tail) = second.split_at(20);
        append(&path, &format!("{first}\n{head}"));

        let mut cache = AgentUsageCache::default();
        sync_file(&mut cache, &path, Source::Codex, &Utc).unwrap();
        let today = now.date_naive();
        assert_eq!(cache.files[&path].codex.daily[&today].total, 100);
        assert_eq!(cache.files[&path].offset, (first.len() + 1) as u64);

        append(&path, &format!("{tail}\n"));
        sync_file(&mut cache, &path, Source::Codex, &Utc).unwrap();
        assert_eq!(cache.files[&path].codex.daily[&today].total, 250);

        let opens = cache.opens;
        sync_file(&mut cache, &path, Source::Codex, &Utc).unwrap();
        assert_eq!(cache.opens, opens, "unchanged file must not be opened again");
    }

    #[test]
    fn sync_starts_over_when_the_file_shrinks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout-b.jsonl");
        let now = Utc::now();
        append(&path, &format!("{}\n{}\n", codex_line(now, 100), codex_line(now, 900)));
        let mut cache = AgentUsageCache::default();
        sync_file(&mut cache, &path, Source::Codex, &Utc).unwrap();

        fs::write(&path, format!("{}\n", codex_line(now, 40))).unwrap();
        sync_file(&mut cache, &path, Source::Codex, &Utc).unwrap();
        assert_eq!(cache.files[&path].codex.daily[&now.date_naive()].total, 40);
    }

    #[test]
    fn last_rate_is_found_across_small_chunk_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout-c.jsonl");
        let now = Utc::now();
        let filler = r#"{"type":"response_item","payload":{"type":"message"}}"#;
        let text = format!(
            "{}\n{filler}\n{filler}\n{}\n{filler}\n",
            codex_rate_line(now, 10.0),
            codex_rate_line(now, 30.0)
        );
        fs::write(&path, text).unwrap();
        let event = last_rate_in_file(&path, 7, 10_000).unwrap().expect("rate line");
        assert_eq!(event.rate.unwrap().primary.unwrap().used_percent, 30.0);
    }

    #[test]
    fn last_rate_scan_stops_at_the_byte_budget() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout-d.jsonl");
        let now = Utc::now();
        let filler = format!("{}\n", r#"{"type":"response_item","payload":{"type":"message","text":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}"#.repeat(4));
        fs::write(&path, format!("{}\n{filler}", codex_rate_line(now, 55.0))).unwrap();
        assert!(last_rate_in_file(&path, 64, 50).unwrap().is_none());
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        roots: UsageRoots,
        now: DateTime<Utc>,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let now = Utc::now();
        let codex_file = home.join(".codex/sessions/2026/11/20/rollout-1.jsonl");
        append(&codex_file, &format!("{}\n", codex_line(now - Duration::days(2), 1000)));
        append(&codex_file, &format!("{}\n", codex_line(now, 1200)));
        append(&codex_file, &format!("{}\n", codex_rate_line(now, 20.0)));
        append(&codex_file, &format!("{}\n", codex_line(now, 1500)));
        let claude_file = home.join(".claude/projects/project-x/session.jsonl");
        append(&claude_file, &format!("{}\n", claude_line(now, "msg_1", "opus", 10, 5)));
        append(&claude_file, &format!("{}\n", claude_line(now, "msg_1", "opus", 10, 5)));
        append(&claude_file, &format!("{}\n", claude_line(now - Duration::days(2), "msg_2", "sonnet", 1, 1)));
        append(&claude_file, &format!("{}\n", claude_line(now - Duration::days(8), "msg_3", "haiku", 50, 49)));
        let roots = UsageRoots::from_home(home);
        Fixture { _dir: dir, roots, now }
    }

    #[test]
    fn disabled_snapshot_never_opens_a_log_file() {
        let fixture = fixture();
        let cache = Mutex::new(AgentUsageCache::default());
        let snapshot = snapshot_with(&cache, false, &fixture.roots, fixture.now).unwrap();
        assert_eq!(snapshot.status, "disabled");
        assert!(snapshot.agents.is_empty());
        assert_eq!(cache.lock().unwrap().opens, 0);
    }

    #[test]
    fn enabled_snapshot_summarises_codex_and_claude_within_the_week_window() {
        let fixture = fixture();
        let cache = Mutex::new(AgentUsageCache::default());
        let snapshot = snapshot_with(&cache, true, &fixture.roots, fixture.now).unwrap();
        assert_eq!(snapshot.status, "ok");
        assert!(cache.lock().unwrap().opens > 0);

        let ids: Vec<&str> = snapshot.agents.iter().map(|agent| agent.id.as_str()).collect();
        assert_eq!(ids, vec!["codex", "claude", "agy", "custom"]);
        let codex = &snapshot.agents[0];
        assert!(codex.available && codex.limits_supported);
        // Deltas: 1000 two days ago, then 200 and 300 today (cumulative 1000 -> 1200 -> 1500).
        assert_eq!(codex.today.total, 500);
        assert_eq!(codex.week.total, 1500);
        let limits = codex.limits.as_ref().expect("codex limits");
        assert_eq!(limits.primary.as_ref().unwrap().remaining_percent, 80.0);
        assert_eq!(limits.primary.as_ref().unwrap().window_minutes, 300);
        assert!(limits.secondary.is_none());

        let claude = &snapshot.agents[1];
        assert!(claude.available && !claude.limits_supported && claude.limits.is_none());
        assert_eq!(claude.today.total, 15);
        assert_eq!(claude.week.total, 17);
        assert_eq!(
            claude.models,
            vec![
                ModelUsage { model: "opus".into(), total: 15 },
                ModelUsage { model: "sonnet".into(), total: 2 },
            ]
        );
        assert!(!snapshot.agents[2].supported && !snapshot.agents[3].supported);
    }

    #[test]
    fn snapshot_json_carries_no_paths_or_message_content() {
        let fixture = fixture();
        let cache = Mutex::new(AgentUsageCache::default());
        let snapshot = snapshot_with(&cache, true, &fixture.roots, fixture.now).unwrap();
        let json = serde_json::to_string(&snapshot).unwrap();
        let marker = fixture._dir.path().file_name().unwrap().to_str().unwrap().to_owned();
        assert!(!json.contains(&marker));
        assert!(!json.contains("synthetic/project"));
        assert!(!json.contains("cwd"));
        assert!(!json.contains(".jsonl"));
    }
}
