//! Cluster batch fan-out with progress events.
//!
//! Spawns one tokio task per machine behind a semaphore (`max_concurrency`,
//! default 8). Each task runs the supplied async closure and pushes
//! BatchEvent updates to an unbounded mpsc sender so callers can stream
//! progress to the frontend.

use crate::error::VoloResult;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::sync::Arc;
use tokio::sync::{mpsc, Semaphore};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum BatchStatus {
    Running,
    Ok,
    Err,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BatchEvent {
    pub machine_id: i64,
    pub status: BatchStatus,
    pub message: Option<String>,
}

pub const DEFAULT_MAX_CONCURRENCY: usize = 8;

/// Run `op` against each machine_id concurrently, capped at `max_concurrency`.
/// Returns the receiver — caller owns the lifetime and should `recv()` until
/// it yields None (all senders dropped). A "Running" event is emitted before
/// each op starts; "Ok" or "Err" after.
pub async fn run_batch<F, Fut, T>(
    machine_ids: Vec<i64>,
    max_concurrency: usize,
    op: F,
) -> mpsc::UnboundedReceiver<BatchEvent>
where
    F: Fn(i64) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = VoloResult<T>> + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = mpsc::unbounded_channel();
    let semaphore = Arc::new(Semaphore::new(max_concurrency.max(1)));
    let op = Arc::new(op);
    for machine_id in machine_ids {
        let tx = tx.clone();
        let semaphore = semaphore.clone();
        let op = op.clone();
        tokio::spawn(async move {
            let _permit = match semaphore.acquire_owned().await {
                Ok(p) => p,
                Err(_) => return,
            };
            let _ = tx.send(BatchEvent {
                machine_id,
                status: BatchStatus::Running,
                message: None,
            });
            let result = op(machine_id).await;
            let event = match result {
                Ok(_) => BatchEvent {
                    machine_id,
                    status: BatchStatus::Ok,
                    message: None,
                },
                Err(e) => BatchEvent {
                    machine_id,
                    status: BatchStatus::Err,
                    message: Some(e.to_string()),
                },
            };
            let _ = tx.send(event);
        });
    }
    drop(tx); // close the channel once all spawned tasks have dropped their clones
    rx
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::VoloError;

    #[tokio::test]
    async fn run_batch_emits_running_then_ok_for_each_machine() {
        let mut rx = run_batch(vec![1, 2, 3], 8, |id| async move {
            Ok::<_, VoloError>(id)
        })
        .await;

        let mut counts = std::collections::HashMap::new();
        while let Some(ev) = rx.recv().await {
            *counts.entry((ev.machine_id, ev.status)).or_insert(0) += 1;
        }
        for id in [1i64, 2, 3] {
            assert_eq!(counts.get(&(id, BatchStatus::Running)).copied(), Some(1));
            assert_eq!(counts.get(&(id, BatchStatus::Ok)).copied(), Some(1));
        }
    }

    #[tokio::test]
    async fn run_batch_reports_errors_with_message() {
        let mut rx = run_batch(vec![1], 4, |_id| async move {
            Err::<(), _>(VoloError::OperationFailed("nope".to_string()))
        })
        .await;

        let mut events = Vec::new();
        while let Some(ev) = rx.recv().await {
            events.push(ev);
        }
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].status, BatchStatus::Running);
        assert_eq!(events[1].status, BatchStatus::Err);
        assert!(events[1].message.as_ref().unwrap().contains("nope"));
    }

    #[tokio::test]
    async fn run_batch_respects_concurrency_cap() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        // Scope counters to this test to avoid cross-test contamination.
        let in_flight = Arc::new(AtomicUsize::new(0));
        let max_observed = Arc::new(AtomicUsize::new(0));
        let in_flight_op = in_flight.clone();
        let max_observed_op = max_observed.clone();

        let mut rx = run_batch((1..=10).collect(), 3, move |_id| {
            let in_flight = in_flight_op.clone();
            let max_observed = max_observed_op.clone();
            async move {
                let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                max_observed.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                in_flight.fetch_sub(1, Ordering::SeqCst);
                Ok::<_, VoloError>(())
            }
        })
        .await;
        while rx.recv().await.is_some() {}
        assert!(max_observed.load(Ordering::SeqCst) <= 3);
    }
}
