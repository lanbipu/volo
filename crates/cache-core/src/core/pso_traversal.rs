//! PSO 遍历引擎：预跑期间经 Remote Control WebSocket 驱动 nDisplay root actor
//! 扫场，把固定机位看不到的 shader 集也编译进 GPU 驱动缓存。
//!
//! P0 实测依据（docs/cache/pso-p0-report.md · S2）：
//! - `-game` + `-RCWebControlEnable` 下 WS 30020 对外可达（HTTP 30010 仅 localhost）；
//! - WS 报文 `{"MessageName":"http","Parameters":{URL,Verb,RequestId,Body}}` 复用整张
//!   HTTP 路由表（UE 5.5 `WebRemoteControl.cpp:832-841` 注册 "http" 路由，
//!   `RemoteControlRequest.h` `FRCRequestWrapper{URL,Verb,RequestId,Body}`）；
//! - actor 发现无裸端点 → `GetAllActorsOfClass` CDO 调用；transform 读写
//!   `K2_GetActorLocation` / `K2_SetActorLocationAndRotation` 已验证。
//!
//! 收敛判据（设计定案，禁止百分比覆盖率）：hitch 增量与驱动缓存增长双曲线走平
//! 且至少完成一整个位姿循环 → 提前结束预跑段（置 watchdog 位 = 计划内完成）。

use crate::core::ue_runner::RunnerCancel;
use crate::error::{VoloError, VoloResult};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TraversalSpec {
    /// Render node host (WS 直连，非 SSH 通道)。
    pub host: String,
    #[serde(default = "default_ws_port")]
    pub ws_port: u16,
    /// 已加载地图的包路径（如 `/Game/InCamVFXBP/Maps/LED_CurvedStage`）——
    /// `GetAllActorsOfClass` 的 WorldContextObject 需要它；-game 下无 PIE 前缀。
    pub map_path: String,
    /// 每个位姿的停留时间（给渲染与 PSO 编译留窗口）。
    #[serde(default = "default_dwell_ms")]
    pub dwell_ms: u64,
    /// yaw 扫描步长（度）。
    #[serde(default = "default_yaw_step_deg")]
    pub yaw_step_deg: f64,
    /// pitch 档位（度，围绕原始姿态）。
    #[serde(default = "default_pitch_levels_deg")]
    pub pitch_levels_deg: Vec<f64>,
    /// 收敛采样间隔（秒）：每次采样读 hitch 计数 + SSH 探驱动缓存字节数。
    #[serde(default = "default_probe_interval_secs")]
    pub probe_interval_secs: u64,
}

fn default_ws_port() -> u16 {
    30020
}
fn default_dwell_ms() -> u64 {
    2000
}
fn default_yaw_step_deg() -> f64 {
    30.0
}
fn default_pitch_levels_deg() -> Vec<f64> {
    vec![-15.0, 0.0, 15.0]
}
fn default_probe_interval_secs() -> u64 {
    30
}

pub fn validate_traversal_spec(spec: &TraversalSpec) -> VoloResult<()> {
    if spec.map_path.trim().is_empty() {
        return Err(VoloError::InvalidInput(
            "traversal map_path is required (loaded map package path)".into(),
        ));
    }
    if !(1.0..=180.0).contains(&spec.yaw_step_deg) {
        return Err(VoloError::InvalidInput(
            "traversal yaw_step_deg must be in 1..=180".into(),
        ));
    }
    if spec.dwell_ms < 200 {
        return Err(VoloError::InvalidInput(
            "traversal dwell_ms must be >= 200".into(),
        ));
    }
    Ok(())
}

/// 一圈的位姿序列：pitch 档 × yaw 步（围绕 actor 原始 rotation 偏移）。
/// 平移不动——LED 舞台的 root actor 旋转已改变各视锥看到的内容集合，
/// 位移反而可能把视锥移出内容边界。
pub fn pose_cycle(spec: &TraversalSpec) -> Vec<(f64, f64)> {
    let mut poses = Vec::new();
    let steps = (360.0 / spec.yaw_step_deg).floor().max(1.0) as usize;
    for pitch in &spec.pitch_levels_deg {
        for i in 0..steps {
            poses.push((*pitch, i as f64 * spec.yaw_step_deg));
        }
    }
    poses
}

#[derive(Debug, Clone, Serialize)]
pub enum TraversalEvent {
    Info(String),
    /// 一次收敛采样：hitch 累计值 + 驱动缓存字节数。
    Sample {
        hitch_count: i64,
        cache_bytes: i64,
        cycles_completed: u32,
    },
    Converged {
        cycles_completed: u32,
        poses_sent: u64,
    },
    Error(String),
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct TraversalOutcome {
    pub converged: bool,
    pub cycles_completed: u32,
    pub poses_sent: u64,
    pub last_cache_bytes: Option<i64>,
    pub error: Option<String>,
}

pub struct TraversalHandle {
    pub stop: Arc<AtomicBool>,
    pub events: mpsc::UnboundedReceiver<TraversalEvent>,
    pub join: tokio::task::JoinHandle<TraversalOutcome>,
}

/// 收敛检测：连续 `REQUIRED_FLAT_SAMPLES` 次采样 hitch 零增量且缓存增长小于
/// `FLAT_CACHE_EPSILON_BYTES`，并且至少完成一整圈位姿 → 收敛。
pub const REQUIRED_FLAT_SAMPLES: u32 = 2;
pub const FLAT_CACHE_EPSILON_BYTES: i64 = 1_000_000;

#[derive(Debug, Default)]
pub struct ConvergenceTracker {
    last_hitches: Option<i64>,
    last_cache_bytes: Option<i64>,
    flat_samples: u32,
}

impl ConvergenceTracker {
    /// 喂入一次采样，返回当前是否满足「双曲线走平」。cycles_completed 的
    /// 一整圈约束由调用方叠加（tracker 只看曲线）。
    pub fn feed(&mut self, hitches: i64, cache_bytes: i64) -> bool {
        let hitch_flat = self.last_hitches.map(|prev| hitches <= prev).unwrap_or(false);
        let cache_flat = self
            .last_cache_bytes
            .map(|prev| (cache_bytes - prev).abs() < FLAT_CACHE_EPSILON_BYTES)
            .unwrap_or(false);
        if hitch_flat && cache_flat {
            self.flat_samples += 1;
        } else {
            self.flat_samples = 0;
        }
        self.last_hitches = Some(hitches);
        self.last_cache_bytes = Some(cache_bytes);
        self.flat_samples >= REQUIRED_FLAT_SAMPLES
    }
}

// ---------------------------------------------------------------------------
// RC WebSocket 客户端（消息面 = HTTP 路由表经 "http" wrapper）
// ---------------------------------------------------------------------------

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub struct RcWsClient {
    stream: WsStream,
    next_id: i32,
}

impl RcWsClient {
    /// 带重试的连接：UE 启动到 RC 服务就绪需要数十秒，逐次退避直到
    /// `deadline_secs` 用尽。
    pub async fn connect_with_retry(
        host: &str,
        port: u16,
        deadline_secs: u64,
        stop: &AtomicBool,
    ) -> VoloResult<Self> {
        let url = format!("ws://{}:{}", host, port);
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(deadline_secs);
        let mut last_err = String::new();
        while tokio::time::Instant::now() < deadline {
            if stop.load(Ordering::Relaxed) {
                return Err(VoloError::OperationFailed("traversal stopped".into()));
            }
            match tokio_tungstenite::connect_async(&url).await {
                Ok((stream, _resp)) => {
                    return Ok(Self { stream, next_id: 1 });
                }
                Err(err) => {
                    last_err = err.to_string();
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                }
            }
        }
        Err(VoloError::OperationFailed(format!(
            "RC websocket {} unreachable within {}s: {}",
            url, deadline_secs, last_err
        )))
    }

    /// 经 "http" wrapper 调 `/remote/object/call`，返回响应 JSON。
    /// 响应帧是 wrapped HTTP response（含 RequestId），取首个 JSON 对象体。
    pub async fn object_call(
        &mut self,
        object_path: &str,
        function_name: &str,
        parameters: serde_json::Value,
    ) -> VoloResult<serde_json::Value> {
        let request_id = self.next_id;
        self.next_id += 1;
        let msg = serde_json::json!({
            "MessageName": "http",
            "Id": request_id,
            "Parameters": {
                "URL": "/remote/object/call",
                "Verb": "PUT",
                "RequestId": request_id,
                "Body": {
                    "objectPath": object_path,
                    "functionName": function_name,
                    "parameters": parameters,
                }
            }
        });
        self.stream
            .send(Message::Text(msg.to_string()))
            .await
            .map_err(|e| VoloError::OperationFailed(format!("rc ws send: {e}")))?;
        // 读到属于本次调用的文本帧为止（服务端按序应答，容忍中间的非文本帧）。
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let remain = deadline
                .checked_duration_since(tokio::time::Instant::now())
                .ok_or_else(|| VoloError::OperationFailed("rc ws response timeout".into()))?;
            let frame = tokio::time::timeout(remain, self.stream.next())
                .await
                .map_err(|_| VoloError::OperationFailed("rc ws response timeout".into()))?
                .ok_or_else(|| VoloError::OperationFailed("rc ws closed".into()))?
                .map_err(|e| VoloError::OperationFailed(format!("rc ws recv: {e}")))?;
            // UE 侧 WebSocketServer.Send 发的是 UTF-8 字节 → tungstenite 收到的
            // 是 Binary 帧（真机实锤：只收 Text 会一直超时），两种都解析。
            let text = match frame {
                Message::Text(text) => Some(text),
                Message::Binary(bytes) => String::from_utf8(bytes).ok(),
                _ => None,
            };
            if let Some(text) = text {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                    return Ok(v);
                }
            }
        }
    }
}

/// 在已加载世界里找 DisplayClusterRootActor（P0 验证过的 CDO 调用路径）。
pub async fn find_root_actor(client: &mut RcWsClient, map_path: &str) -> VoloResult<String> {
    let map_name = map_path.rsplit('/').next().unwrap_or_default();
    let world_context = format!("{}.{}:PersistentLevel", map_path, map_name);
    let resp = client
        .object_call(
            "/Script/Engine.Default__GameplayStatics",
            "GetAllActorsOfClass",
            serde_json::json!({
                "WorldContextObject": world_context,
                "ActorClass": "/Script/DisplayCluster.DisplayClusterRootActor",
            }),
        )
        .await?;
    resp.pointer("/ResponseBody/OutActors/0")
        .or_else(|| resp.pointer("/OutActors/0"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| {
            VoloError::OperationFailed(format!(
                "no DisplayClusterRootActor found in {} (rc response: {})",
                world_context, resp
            ))
        })
}

fn f64_at(value: &serde_json::Value, pointers: &[&str]) -> Option<f64> {
    pointers.iter().find_map(|p| value.pointer(p)?.as_f64())
}

/// 启动遍历任务。`hitch_counter` 由 warmup 驱动循环持续累加；`cancel` 是当前
/// 预跑段的 RunnerCancel——收敛时置 `watchdog=true` 停跑（= 计划内完成语义，
/// 编排侧会照常转入验证段）。
pub fn spawn_traversal(
    spec: TraversalSpec,
    hitch_counter: Arc<AtomicI64>,
    cancel: Arc<Mutex<RunnerCancel>>,
) -> TraversalHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_task = stop.clone();
    let (tx, rx) = mpsc::unbounded_channel();

    let join = tokio::spawn(async move {
        let mut outcome = TraversalOutcome::default();
        let emit = |ev: TraversalEvent| {
            let _ = tx.send(ev);
        };

        // 1. 连 RC WS（UE 启动窗口内重试）。
        let mut client = match RcWsClient::connect_with_retry(
            &spec.host,
            spec.ws_port,
            120,
            &stop_for_task,
        )
        .await
        {
            Ok(c) => c,
            Err(err) => {
                outcome.error = Some(err.to_string());
                emit(TraversalEvent::Error(format!("rc connect failed: {err}")));
                return outcome;
            }
        };
        emit(TraversalEvent::Info(format!(
            "rc websocket connected ({}:{})",
            spec.host, spec.ws_port
        )));

        // 2. 找 root actor + 原始姿态。
        let actor = match find_root_actor(&mut client, &spec.map_path).await {
            Ok(a) => a,
            Err(err) => {
                outcome.error = Some(err.to_string());
                emit(TraversalEvent::Error(err.to_string()));
                return outcome;
            }
        };
        emit(TraversalEvent::Info(format!("root actor: {}", actor)));
        let base_rot = match client
            .object_call(&actor, "K2_GetActorRotation", serde_json::json!({}))
            .await
        {
            Ok(resp) => (
                f64_at(&resp, &["/ResponseBody/ReturnValue/Pitch", "/ReturnValue/Pitch"])
                    .unwrap_or(0.0),
                f64_at(&resp, &["/ResponseBody/ReturnValue/Yaw", "/ReturnValue/Yaw"])
                    .unwrap_or(0.0),
                f64_at(&resp, &["/ResponseBody/ReturnValue/Roll", "/ReturnValue/Roll"])
                    .unwrap_or(0.0),
            ),
            Err(err) => {
                outcome.error = Some(err.to_string());
                emit(TraversalEvent::Error(err.to_string()));
                return outcome;
            }
        };

        // 3. 位姿循环 + 收敛采样。
        let poses = pose_cycle(&spec);
        let mut tracker = ConvergenceTracker::default();
        let mut next_probe =
            tokio::time::Instant::now() + std::time::Duration::from_secs(spec.probe_interval_secs);
        let probe_host = spec.host.clone();

        'outer: loop {
            for (pitch, yaw) in &poses {
                if stop_for_task.load(Ordering::Relaxed) {
                    break 'outer;
                }
                {
                    // 预跑段已被外部结束（watchdog/取消）→ 停手。
                    let state = cancel.lock().await;
                    if state.requested {
                        break 'outer;
                    }
                }
                let rot = serde_json::json!({
                    "Pitch": base_rot.0 + pitch,
                    "Yaw": base_rot.1 + yaw,
                    "Roll": base_rot.2,
                });
                if let Err(err) = client
                    .object_call(
                        &actor,
                        "K2_SetActorRotation",
                        serde_json::json!({ "NewRotation": rot, "bTeleportPhysics": true }),
                    )
                    .await
                {
                    outcome.error = Some(err.to_string());
                    emit(TraversalEvent::Error(format!("pose write failed: {err}")));
                    break 'outer;
                }
                outcome.poses_sent += 1;
                tokio::time::sleep(std::time::Duration::from_millis(spec.dwell_ms)).await;

                // 收敛采样（与位姿节拍解耦，按 interval 触发）。
                if tokio::time::Instant::now() >= next_probe {
                    next_probe = tokio::time::Instant::now()
                        + std::time::Duration::from_secs(spec.probe_interval_secs);
                    let host = probe_host.clone();
                    let cache_bytes = tokio::task::spawn_blocking(move || {
                        crate::core::driver_cache_probe::probe(&host).map(|p| p.total_bytes)
                    })
                    .await
                    .ok()
                    .and_then(Result::ok);
                    let hitches = hitch_counter.load(Ordering::Relaxed);
                    if let Some(bytes) = cache_bytes {
                        outcome.last_cache_bytes = Some(bytes);
                        emit(TraversalEvent::Sample {
                            hitch_count: hitches,
                            cache_bytes: bytes,
                            cycles_completed: outcome.cycles_completed,
                        });
                        if tracker.feed(hitches, bytes) && outcome.cycles_completed >= 1 {
                            outcome.converged = true;
                            emit(TraversalEvent::Converged {
                                cycles_completed: outcome.cycles_completed,
                                poses_sent: outcome.poses_sent,
                            });
                            // 计划内提前完成：与 max-minutes watchdog 同语义。
                            let mut state = cancel.lock().await;
                            if !state.requested {
                                state.requested = true;
                                state.watchdog = true;
                            }
                            break 'outer;
                        }
                    }
                }
            }
            outcome.cycles_completed += 1;
            emit(TraversalEvent::Info(format!(
                "pose cycle {} complete ({} poses)",
                outcome.cycles_completed,
                poses.len()
            )));
        }

        // 4. 复位原始姿态（尽力而为——进程可能已被停）。
        let _ = client
            .object_call(
                &actor,
                "K2_SetActorRotation",
                serde_json::json!({
                    "NewRotation": {"Pitch": base_rot.0, "Yaw": base_rot.1, "Roll": base_rot.2},
                    "bTeleportPhysics": true
                }),
            )
            .await;
        outcome
    });

    TraversalHandle {
        stop,
        events: rx,
        join,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pose_cycle_covers_full_yaw_sweep_per_pitch_level() {
        let spec = TraversalSpec {
            host: "h".into(),
            ws_port: 30020,
            map_path: "/Game/M".into(),
            dwell_ms: 2000,
            yaw_step_deg: 30.0,
            pitch_levels_deg: vec![-15.0, 0.0, 15.0],
            probe_interval_secs: 30,
        };
        let poses = pose_cycle(&spec);
        assert_eq!(poses.len(), 36); // 3 pitch × 12 yaw
        assert!(poses.contains(&(0.0, 0.0)));
        assert!(poses.contains(&(15.0, 330.0)));
        assert!(!poses.iter().any(|(_, yaw)| *yaw >= 360.0));
    }

    #[test]
    fn convergence_needs_consecutive_flat_samples() {
        let mut t = ConvergenceTracker::default();
        assert!(!t.feed(100, 30_000_000)); // 首样无基线
        assert!(!t.feed(100, 30_100_000)); // flat #1（增量 <1MB 且 hitch 不涨）
        assert!(t.feed(100, 30_150_000)); // flat #2 → 收敛
    }

    #[test]
    fn convergence_resets_on_new_hitches_or_growth() {
        let mut t = ConvergenceTracker::default();
        t.feed(100, 30_000_000);
        assert!(!t.feed(105, 30_000_000)); // hitch 还在涨 → 清零
        assert!(!t.feed(105, 35_000_000)); // 缓存还在长 → 清零
        assert!(!t.feed(105, 35_100_000)); // flat #1
        assert!(t.feed(105, 35_200_000)); // flat #2 → 收敛
    }

    #[test]
    fn validate_traversal_spec_enforces_bounds() {
        let good = TraversalSpec {
            host: "h".into(),
            ws_port: 30020,
            map_path: "/Game/M".into(),
            dwell_ms: 2000,
            yaw_step_deg: 30.0,
            pitch_levels_deg: vec![0.0],
            probe_interval_secs: 30,
        };
        assert!(validate_traversal_spec(&good).is_ok());
        assert!(validate_traversal_spec(&TraversalSpec {
            map_path: " ".into(),
            ..good.clone()
        })
        .is_err());
        assert!(validate_traversal_spec(&TraversalSpec {
            yaw_step_deg: 0.0,
            ..good.clone()
        })
        .is_err());
        assert!(validate_traversal_spec(&TraversalSpec {
            dwell_ms: 10,
            ..good
        })
        .is_err());
    }
}
