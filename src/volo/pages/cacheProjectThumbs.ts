// @ts-nocheck
/* Volo — Cache · 工程缩略图探测（中立共享）
   ------------------------------------------------------------------
   get_project_thumbnail 懒加载 + 模块级内存缓存 + IndexedDB 持久化。
   DDC PAK / PSO 共用同一份缓存（工程清单本就共享），切页不重探、不打探测风暴。
   DB 名沿用历史 `volo-ddc-pak`，保留已落盘的缩略图。 */
import * as React from "react";
import { getProjectThumbnail } from "../api/commands";
import { pickSrc, humanBytes } from "./cacheProjectScan";

export const THUMB_FROM_LABEL = {
  uproject_same_name: 'uproject 同名缩略图',
  saved_auto_screenshot: 'Saved 编辑器自动截图（无同名图）',
  saved_autosequence: 'Saved 回退缩略图（无同名图）',
};

const THUMB_CACHE = { thumbs: {}, tried: new Set(), inflight: new Set() };
const THUMB_DB_NAME = 'volo-ddc-pak';
const THUMB_STORE_NAME = 'thumbs';
const THUMB_RECORD_KEY = 'cache';
const THUMB_CONCURRENCY = 8;
let thumbPersistTimer = null;
let thumbPersistMerged = false;

const emptyThumbPersist = () => ({ thumbs: {}, tried: [] });
const openThumbDb = () => new Promise((resolve) => {
  if (typeof indexedDB === 'undefined') { resolve(null); return; }
  let settled = false;
  const finish = (db) => {
    if (settled) { if (db) db.close(); return; }
    settled = true;
    resolve(db);
  };
  try {
    const req = indexedDB.open(THUMB_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(THUMB_STORE_NAME)) db.createObjectStore(THUMB_STORE_NAME);
    };
    req.onsuccess = () => finish(req.result);
    req.onerror = () => finish(null);
    req.onblocked = () => finish(null);
  } catch (e) { finish(null); }
});
const readThumbPersist = () => openThumbDb().then((db) => new Promise((resolve) => {
  if (!db) { resolve(emptyThumbPersist()); return; }
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    db.close();
    resolve(value);
  };
  try {
    const tx = db.transaction(THUMB_STORE_NAME, 'readonly');
    const req = tx.objectStore(THUMB_STORE_NAME).get(THUMB_RECORD_KEY);
    req.onsuccess = () => {
      const value = req.result || {};
      finish({
        thumbs: value.thumbs && typeof value.thumbs === 'object' ? value.thumbs : {},
        tried: Array.isArray(value.tried) ? value.tried : [],
      });
    };
    req.onerror = () => finish(emptyThumbPersist());
    tx.onabort = () => finish(emptyThumbPersist());
  } catch (e) { finish(emptyThumbPersist()); }
})).catch(() => emptyThumbPersist());
const writeThumbPersist = (value) => openThumbDb().then((db) => new Promise((resolve) => {
  if (!db) { resolve(); return; }
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    db.close();
    resolve();
  };
  try {
    const tx = db.transaction(THUMB_STORE_NAME, 'readwrite');
    tx.objectStore(THUMB_STORE_NAME).put(value, THUMB_RECORD_KEY);
    tx.oncomplete = finish;
    tx.onerror = finish;
    tx.onabort = finish;
  } catch (e) { finish(); }
})).catch(() => {});
const persistThumbCache = () => writeThumbPersist({
  thumbs: THUMB_CACHE.thumbs,
  tried: Array.from(THUMB_CACHE.tried),
});
const scheduleThumbPersist = () => {
  clearTimeout(thumbPersistTimer);
  thumbPersistTimer = setTimeout(persistThumbCache, 800);
};
const THUMB_PERSIST_READY = readThumbPersist();

/* projects: 当前可见工程列表；扫完后调 invalidate() 强制重探（mtime/新工程）。
   includeSize：是否把 probe.size_bytes 写进 patch（DDC PAK 列表需要，PSO 不用）。 */
export function useProjectThumbs(projects, { includeSize = true } = {}) {
  const { useState, useEffect } = React;
  const [thumbs, setThumbs] = useState(() => THUMB_CACHE.thumbs);
  const [thumbGen, setThumbGen] = useState(0);
  const projectCount = (projects || []).length;

  useEffect(() => {
    let alive = true;
    THUMB_PERSIST_READY.then((persisted) => {
      if (!thumbPersistMerged) {
        THUMB_CACHE.thumbs = Object.assign({}, persisted.thumbs, THUMB_CACHE.thumbs);
        THUMB_CACHE.tried = new Set(persisted.tried.concat(Array.from(THUMB_CACHE.tried)));
        thumbPersistMerged = true;
        scheduleThumbPersist();
      }
      if (!alive) return;
      setThumbs(THUMB_CACHE.thumbs);
      const queue = (projects || []).filter((p) =>
        !THUMB_CACHE.tried.has(p.id) && !THUMB_CACHE.inflight.has(p.id));
      let next = 0;
      const pump = () => {
        if (!alive || next >= queue.length) return;
        const p = queue[next++];
        if (THUMB_CACHE.tried.has(p.id) || THUMB_CACHE.inflight.has(p.id)) { pump(); return; }
        const src = pickSrc(p);
        if (!src) { pump(); return; }
        THUMB_CACHE.inflight.add(p.id);
        getProjectThumbnail(Number(p.id), src.machineId).then(
          (probe) => {
            THUMB_CACHE.inflight.delete(p.id);
            if (!alive) return;
            THUMB_CACHE.tried.add(p.id);
            scheduleThumbPersist();
            const t = probe && probe.thumbnail;
            const patch = {};
            if (t) Object.assign(patch, {
              thumb: 'data:image/png;base64,' + t.base64,
              thumbSrc: t.path,
              thumbFrom: THUMB_FROM_LABEL[t.from] || t.from,
              mtime: t.mtime || '',
            });
            if (includeSize && probe && probe.size_bytes != null) patch.size = humanBytes(probe.size_bytes);
            if (Object.keys(patch).length) setThumbs((m) => {
              const nextMap = Object.assign({}, m, { [p.id]: patch });
              THUMB_CACHE.thumbs = nextMap;
              scheduleThumbPersist();
              return nextMap;
            });
            pump();
          },
          () => { THUMB_CACHE.inflight.delete(p.id); if (alive) pump(); });
      };
      for (let i = 0; i < THUMB_CONCURRENCY; i++) pump();
    });
    return () => { alive = false; };
  }, [projectCount, thumbGen, includeSize]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = () => {
    THUMB_CACHE.tried = new Set();
    THUMB_CACHE.inflight = new Set();
    persistThumbCache();
    setThumbGen((g) => g + 1);
  };
  const withThumb = (p, extra) => Object.assign({}, p, thumbs[p.id], extra || null);

  return { thumbs, withThumb, invalidate };
}

export {};
