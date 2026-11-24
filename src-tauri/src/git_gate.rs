//! Limits how many Git read commands run at the same time.
//!
//! A workspace can hold many repositories, and every card asks for its status, remote state and
//! outgoing commits as soon as it appears. Running all of those at once saturates the disk and CPU
//! and makes the window stutter, so reads pass through a small first-in, first-out gate.

use std::collections::VecDeque;
use std::sync::{Condvar, Mutex, MutexGuard};

/// How many Git reads may run at once.
pub const GIT_READ_LIMIT: usize = 2;

struct State {
    active: usize,
    next_ticket: u64,
    queue: VecDeque<u64>,
}

/// A fair (first-in, first-out) counting gate. Waiting readers block their own worker thread only.
pub struct ReadGate {
    limit: usize,
    state: Mutex<State>,
    released: Condvar,
}

impl ReadGate {
    pub const fn new(limit: usize) -> Self {
        Self {
            limit,
            state: Mutex::new(State { active: 0, next_ticket: 0, queue: VecDeque::new() }),
            released: Condvar::new(),
        }
    }

    /// Runs `work` once a slot is free. The slot is returned even when `work` panics.
    pub fn run<T>(&self, work: impl FnOnce() -> T) -> T {
        let _slot = self.acquire();
        work()
    }

    /// Number of readers waiting for a slot (not counting the ones running).
    pub fn waiting(&self) -> usize {
        self.lock().queue.len()
    }

    fn acquire(&self) -> Slot<'_> {
        let mut state = self.lock();
        let ticket = state.next_ticket;
        state.next_ticket += 1;
        state.queue.push_back(ticket);
        while !(state.active < self.limit && state.queue.front() == Some(&ticket)) {
            state = self.released.wait(state).unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        state.queue.pop_front();
        state.active += 1;
        drop(state);
        // The next reader in line may now have a free slot as well.
        self.released.notify_all();
        Slot { gate: self }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

struct Slot<'a> {
    gate: &'a ReadGate,
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.gate.lock().active -= 1;
        self.gate.released.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::panic::AssertUnwindSafe;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    fn wait_until(mut condition: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !condition() {
            assert!(Instant::now() < deadline, "condition not reached in time");
            thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn never_runs_more_than_the_limit_at_once() {
        let gate = Arc::new(ReadGate::new(2));
        let in_flight = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let finished = Arc::new(AtomicUsize::new(0));
        let handles: Vec<_> = (0..6)
            .map(|_| {
                let (gate, in_flight, peak, finished) =
                    (gate.clone(), in_flight.clone(), peak.clone(), finished.clone());
                thread::spawn(move || {
                    gate.run(|| {
                        let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(now, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(30));
                        in_flight.fetch_sub(1, Ordering::SeqCst);
                    });
                    finished.fetch_add(1, Ordering::SeqCst);
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("reader thread");
        }
        assert_eq!(finished.load(Ordering::SeqCst), 6, "every read finishes");
        assert!(peak.load(Ordering::SeqCst) <= 2, "peak {} exceeds limit 2", peak.load(Ordering::SeqCst));
    }

    #[test]
    fn queued_reads_start_in_arrival_order() {
        let gate = Arc::new(ReadGate::new(1));
        let order = Arc::new(Mutex::new(Vec::new()));
        let (held_tx, held_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let holder = {
            let gate = gate.clone();
            thread::spawn(move || {
                gate.run(|| {
                    held_tx.send(()).expect("signal held");
                    release_rx.recv().expect("release signal");
                })
            })
        };
        held_rx.recv().expect("slot is held");

        let mut readers = Vec::new();
        for id in 0..4 {
            let (reader_gate, order) = (gate.clone(), order.clone());
            readers.push(thread::spawn(move || reader_gate.run(|| order.lock().expect("order").push(id))));
            wait_until(|| gate.waiting() == id + 1);
        }

        release_tx.send(()).expect("release holder");
        holder.join().expect("holder thread");
        for reader in readers {
            reader.join().expect("reader thread");
        }
        assert_eq!(*order.lock().expect("order"), vec![0, 1, 2, 3]);
    }

    #[test]
    fn a_panicking_read_gives_its_slot_back() {
        let gate = ReadGate::new(1);
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| gate.run(|| panic!("read failed"))));
        assert_eq!(gate.run(|| 7), 7);
        assert_eq!(gate.waiting(), 0);
    }
}
