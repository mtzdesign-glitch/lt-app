/* LT v0.4 — offline capture store + sync queue (IndexedDB).

   Everything the step builder captures is written here FIRST (metadata and
   media blobs), then uploaded by the queue when connectivity allows. Ops are
   idempotent (client-generated equipment ids, path-upsert vault uploads,
   whole-doc KC updates where the newest doc wins), so retries never duplicate.

   Drafts: an in-progress step or equipment form is persisted continuously so
   a force-close or dead battery mid-capture loses nothing — on reopen the
   draft is offered for resume or discard, never silently lost. */

import * as backend from './backend.js';

const DB_NAME = 'lt-builder';

let dbPromise = null;
function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('queue', { keyPath: 'op_id' });
      req.result.createObjectStore('drafts', { keyPath: 'draft_id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idb(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  });
}

/* ---------------- drafts ---------------- */

export function saveDraft(draft) { return idb('drafts', 'readwrite', (s) => s.put(draft)); }
export function getDraft(draftId) { return idb('drafts', 'readonly', (s) => s.get(draftId)); }
export function deleteDraft(draftId) { return idb('drafts', 'readwrite', (s) => s.delete(draftId)); }

/* ---------------- queue ---------------- */

export async function pendingOps() {
  const ops = (await idb('queue', 'readonly', (s) => s.getAll())) || [];
  return ops.sort((a, b) => a.created_at - b.created_at);
}

/* kind: 'equipment_upsert' { payload: record }
         'equipment_delete' { payload: { id } }
         'vault_upload'     { payload: { path, content_type }, blob }
         'kc_doc_update'    { payload: { kc_db_id, doc } }               */
export async function enqueue(kind, payload, blob = null) {
  await idb('queue', 'readwrite', (s) => s.put({
    op_id: crypto.randomUUID(),
    kind, payload, blob,
    created_at: Date.now(),
    tries: 0, last_error: null
  }));
  kick();
  await notify();
}

/* ---------------- engine ---------------- */

let running = false;
const listeners = new Set();

/* fn receives the current pending ops array (empty = all synced).
   Returns an unsubscribe function. */
export function onSyncChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function notify() {
  const ops = await pendingOps();
  listeners.forEach((fn) => { try { fn(ops); } catch { /* listener errors never stall sync */ } });
}

export async function kick() {
  if (running || !navigator.onLine) return;
  running = true;
  try {
    const ops = await pendingOps();
    for (const op of ops) {
      try {
        if (op.kind === 'equipment_upsert') {
          await backend.upsertEquipment(op.payload);
        } else if (op.kind === 'equipment_delete') {
          await backend.deleteEquipment(op.payload.id);
        } else if (op.kind === 'vault_upload') {
          await backend.uploadToVault(op.payload.path, op.blob, op.payload.content_type);
        } else if (op.kind === 'kc_doc_update') {
          /* Only the newest doc per KC needs uploading. */
          const newer = ops.some((o) => o.kind === 'kc_doc_update' &&
            o.payload.kc_db_id === op.payload.kc_db_id && o.created_at > op.created_at);
          if (!newer) await backend.saveKCDoc(op.payload.kc_db_id, op.payload.doc);
        }
        await idb('queue', 'readwrite', (s) => s.delete(op.op_id));
        await notify();
      } catch (e) {
        /* Stop at the first failure (usually connectivity): order is
           preserved and the whole queue retries on the next kick. */
        op.tries += 1;
        op.last_error = String((e && e.message) || e);
        await idb('queue', 'readwrite', (s) => s.put(op));
        break;
      }
    }
  } finally {
    running = false;
    await notify();
  }
}

window.addEventListener('online', kick);
