//! Shared state wrapper for the mesh (LMT) Tauri command group.
//!
//! The mesh DB and the cache DB are both `Arc<Mutex<rusqlite::Connection>>`
//! (`volo_shared::data::Db` and `cache_core::data::Db` are the same concrete
//! type). Tauri keys managed state by `TypeId`, so a bare `app.manage(db)` for
//! both would collide — the second would shadow the first and every
//! `State<Db>` injection would resolve to a single connection. We wrap the
//! mesh DB in this newtype so the two databases stay distinct in the state map.
pub struct MeshDb(pub volo_shared::data::Db);
