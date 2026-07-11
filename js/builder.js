/* LT v0.4 — Step Builder (Capture Agent MVP, phone-first).
   Linear authoring: steps append in sequence; no reorder or edit-existing in
   this build. Equipment is captured once into the enterprise-wide library and
   linked by id (brief §2). Every capture is written to local storage FIRST
   (sync.js) and uploaded in the background, so authoring works with no
   connectivity. In-progress forms persist as drafts continuously: a
   force-close or dead battery mid-capture is resumable, never silently lost. */

import * as backend from './backend.js';
import * as sync from './sync.js';

const MAX_CLIP_SECONDS = 120;   // founder decision 2026-07-11: 2-minute cap per clip
const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'is', 'are', 'be',
  'with', 'for', 'on', 'in', 'at', 'it', 'this', 'that', 'has', 'have']);

let els = null;
let state = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function runBuilder(ctx) {
  els = {
    syncline: document.getElementById('builder-sync'),
    body: document.getElementById('builder-body'),
    done: document.getElementById('btn-builder-done')
  };
  const eq = await backend.listEquipment();
  const pendingOps = await sync.pendingOps();
  const equipment = eq.data || [];
  /* Equipment captured offline isn't on the server yet — merge it in. */
  for (const op of pendingOps) {
    if (op.kind === 'equipment_upsert' && !equipment.some((e) => e.id === op.payload.id)) {
      equipment.push(op.payload);
    }
  }
  state = {
    ctx,
    doc: ctx.kc,
    uid: await backend.userId(),
    equipment,
    pendingOps,
    view: 'home'
  };
  const unsubscribe = sync.onSyncChange(onSync);

  ctx.ui.show('screen-builder');
  const finished = new Promise((resolve) => { state.finish = resolve; });
  els.done.onclick = () => state.finish();

  /* Resume a step draft if one survived a crash or close. */
  const draft = await sync.getDraft(stepDraftId());
  if (draft) {
    const pick = await ctx.ui.modal('An unfinished step from a previous session was found. Resume it?', ['RESUME', 'DISCARD']);
    if (pick === 0) stepForm(draft);
    else { await sync.deleteDraft(stepDraftId()); home(); }
  } else {
    home();
  }

  await finished;
  unsubscribe();
  sync.kick();
}

/* ---------------- sync status ---------------- */

function stepDraftId() { return 'step:' + state.ctx.kcRef.id; }

function onSync(ops) {
  state.pendingOps = ops;
  renderSyncLine();
  if (state.view === 'home') home(); // refresh per-item statuses
}

function renderSyncLine() {
  const n = state.pendingOps.length;
  els.syncline.textContent = n === 0
    ? 'All captures synced.'
    : `${n} capture${n === 1 ? '' : 's'} waiting to sync — uploads resume automatically when online.`;
}

function docPending() {
  return state.pendingOps.some((o) =>
    o.kind === 'kc_doc_update' && o.payload.kc_db_id === state.ctx.kcRef.id);
}

function pathPending(path) {
  return state.pendingOps.some((o) => o.kind === 'vault_upload' && o.payload.path === path);
}

function stepStatus(step) {
  const vid = step.video && step.video.startsWith('vault:') && pathPending(step.video.slice(6));
  return (docPending() || vid) ? '⏳ waiting to sync' : '✓ synced';
}

function equipmentStatus(eq) {
  const p = state.pendingOps.some((o) =>
    (o.kind === 'equipment_upsert' && o.payload.id === eq.id) ||
    (o.kind === 'vault_upload' && eq.photo_path && o.payload.path === eq.photo_path));
  return p ? '⏳ waiting to sync' : '✓ synced';
}

/* ---------------- builder home ---------------- */

function home() {
  state.view = 'home';
  renderSyncLine();
  const steps = state.doc.steps || [];
  els.body.innerHTML = `
    <div class="gate-heading">${escapeHtml(state.doc.title)}</div>
    <div class="screen-sub">Steps are authored in order. Editing existing steps arrives in a later build.</div>
    <div class="builder-list" id="b-steps"></div>
    <button class="btn btn-primary btn-big" id="b-add-step">+ ADD STEP ${steps.length + 1}</button>
    <div class="gate-heading" style="margin-top:10px;">Equipment library</div>
    <div class="screen-sub">Shared across all KCs in your enterprise.</div>
    <div class="builder-list" id="b-equipment"></div>
    <button class="btn btn-secondary" id="b-add-eq">+ ADD EQUIPMENT</button>
  `;

  const stepList = els.body.querySelector('#b-steps');
  if (steps.length === 0) stepList.innerHTML = '<p class="screen-sub">No steps yet.</p>';
  steps.forEach((s, i) => {
    const d = document.createElement('div');
    d.className = 'kc-card card-row';
    d.innerHTML = `
      <div class="card-main">
        <h3>${s.step_id} · ${escapeHtml(s.title)}</h3>
        <div class="kc-meta">${s.equipment_label ? escapeHtml(s.equipment_label) + ' · ' : ''}${s.video ? 'video attached' : 'no video'} · ${stepStatus(s)}</div>
      </div>
      <span class="card-edit">✎ EDIT</span>`;
    d.addEventListener('click', () => stepForm(null, i));
    stepList.appendChild(d);
  });

  const eqList = els.body.querySelector('#b-equipment');
  if (state.equipment.length === 0) eqList.innerHTML = '<p class="screen-sub">No equipment captured yet.</p>';
  for (const eq of state.equipment) {
    const d = document.createElement('div');
    d.className = 'kc-card card-row';
    d.innerHTML = `
      <div class="card-main">
        <h3>${escapeHtml(eq.name)}</h3>
        <div class="kc-meta">${eq.identity_method === 'none' ? 'no identity tag' : escapeHtml(eq.tag_value || '')} · ${equipmentStatus(eq)}</div>
      </div>
      <span class="card-edit">✎ EDIT</span>`;
    d.addEventListener('click', () => equipmentForm(() => home(), eq));
    eqList.appendChild(d);
  }

  els.body.querySelector('#b-add-step').onclick = () => stepForm(null);
  els.body.querySelector('#b-add-eq').onclick = () => equipmentForm(() => home());
}

/* ---------------- step form (linear authoring, brief §3) ---------------- */

let draftTimer = null;
function persistDraft(d) {
  if (!d.draft_id) return; // edits of existing steps are short-lived, not drafted
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => sync.saveDraft(d), 400);
}

function stepForm(existingDraft, editIndex = null) {
  state.view = 'step';
  const steps = state.doc.steps || [];
  let d;
  if (existingDraft) {
    d = existingDraft;
    if (d.editIndex == null) d.editIndex = null; // resumed drafts predate editing
  } else if (editIndex !== null) {
    const s = steps[editIndex];
    d = {
      editIndex, n: editIndex + 1,
      title: s.title, instruction: s.instruction, callout: s.required_callout,
      critical: !!s.critical, prereqs: (s.critical_prerequisites || []).join('\n'),
      equipment_id: s.equipment_id || null,
      videoBlob: null, videoType: null, videoSeconds: 0, videoRef: s.video || null
    };
  } else {
    d = {
      draft_id: stepDraftId(), editIndex: null,
      n: steps.length + 1, title: '', instruction: '', callout: '', critical: false, prereqs: '',
      equipment_id: null, videoBlob: null, videoType: null, videoSeconds: 0, videoRef: null
    };
  }
  const editing = d.editIndex != null;
  const n = editing ? d.editIndex + 1 : steps.length + 1;
  d.n = n; // step count may have changed since the draft was written

  const eq = d.equipment_id ? state.equipment.find((e) => e.id === d.equipment_id) : null;
  const videoNote = d.videoBlob
    ? Math.round(d.videoSeconds) + 's recorded — saved with this step'
    : d.videoRef ? 'Existing video attached — retake to replace it.' : 'No video attached.';

  els.body.innerHTML = `
    <div class="gate-heading">${editing ? 'Edit step S' + String(n).padStart(2, '0') : 'Step ' + n}</div>
    <div class="field">
      <label for="f-title">Step title (short)</label>
      <input id="f-title" type="text" value="${escapeHtml(d.title)}" placeholder="e.g. Close Return Valve">
    </div>
    <div class="field">
      <label for="f-instr">Instruction — exactly what to do</label>
      <textarea id="f-instr" rows="4" placeholder="e.g. Push down on the red handle to close the return valve completely.">${escapeHtml(d.instruction)}</textarea>
    </div>
    <div class="field">
      <label>Equipment for this step</label>
      <button class="btn btn-secondary" id="f-eq">${eq ? 'EQUIPMENT: ' + escapeHtml(eq.name.toUpperCase()) : 'SELECT EQUIPMENT (optional)'}</button>
    </div>
    <div class="field">
      <label>Video demonstration (optional, max 2 minutes)</label>
      <button class="btn btn-secondary" id="f-video">${d.videoBlob || d.videoRef ? 'RETAKE VIDEO' : 'RECORD VIDEO'}</button>
      ${d.videoBlob || d.videoRef ? '<button class="btn btn-tertiary" id="f-video-remove">REMOVE VIDEO</button>' : ''}
      <div class="video-note" id="f-video-note">${videoNote}</div>
    </div>
    <div class="field">
      <label for="f-callout">Completion call-out — what the TECH says out loud when this step is done</label>
      <input id="f-callout" type="text" value="${escapeHtml(d.callout)}" placeholder="e.g. Valve Closed">
    </div>
    <label class="check-item">
      <input type="checkbox" id="f-critical" ${d.critical ? 'checked' : ''}>
      <span class="check-decl">CRITICAL STEP — the TECH must verify prerequisites before it runs</span>
    </label>
    <div class="field" id="f-prereq-field" ${d.critical ? '' : 'hidden'}>
      <label for="f-prereqs">Prerequisites to verify (one per line)</label>
      <textarea id="f-prereqs" rows="3" placeholder="e.g. Pump is running">${escapeHtml(d.prereqs)}</textarea>
    </div>
    <button class="btn btn-primary btn-big" id="f-save">${editing ? 'SAVE CHANGES' : 'SAVE STEP ' + n}</button>
    ${editing ? '<button class="btn btn-danger-ghost" id="f-delete">DELETE THIS STEP</button>' : ''}
    <button class="btn btn-tertiary" id="f-cancel">${editing ? 'CANCEL — KEEP ORIGINAL' : 'CANCEL THIS STEP'}</button>
  `;

  const $ = (id) => els.body.querySelector(id);

  $('#f-title').addEventListener('input', (e) => { d.title = e.target.value; persistDraft(d); });
  $('#f-title').addEventListener('blur', () => {
    if (d.title.trim() && !d.callout) {
      d.callout = `Step ${n} complete`;
      $('#f-callout').value = d.callout;
      persistDraft(d);
    }
  });
  $('#f-instr').addEventListener('input', (e) => { d.instruction = e.target.value; persistDraft(d); });
  $('#f-callout').addEventListener('input', (e) => { d.callout = e.target.value; persistDraft(d); });
  $('#f-critical').addEventListener('change', (e) => {
    d.critical = e.target.checked;
    $('#f-prereq-field').hidden = !d.critical;
    persistDraft(d);
  });
  $('#f-prereqs').addEventListener('input', (e) => { d.prereqs = e.target.value; persistDraft(d); });

  $('#f-eq').addEventListener('click', () => equipmentPicker(d));
  $('#f-video').addEventListener('click', async () => {
    const rec = await captureVideo();
    if (rec) {
      d.videoBlob = rec.blob; d.videoType = rec.type; d.videoSeconds = rec.seconds;
      if (d.draft_id) await sync.saveDraft(d); // blobs save immediately, not debounced
      stepForm(d);
    }
  });
  const removeBtn = $('#f-video-remove');
  if (removeBtn) removeBtn.addEventListener('click', () => {
    d.videoBlob = null; d.videoType = null; d.videoSeconds = 0; d.videoRef = null;
    persistDraft(d);
    stepForm(d);
  });
  $('#f-save').addEventListener('click', () => saveStep(d));
  const deleteBtn = $('#f-delete');
  if (deleteBtn) deleteBtn.addEventListener('click', async () => {
    const sure = await state.ctx.ui.modal(
      `Delete step S${String(n).padStart(2, '0')} — "${d.title}"? Later steps renumber automatically. This cannot be undone.`,
      ['KEEP THE STEP', 'DELETE STEP']);
    if (sure !== 1) return;
    state.doc.steps.splice(d.editIndex, 1);
    normalizeDoc();
    await persistDoc();
    home();
  });
  $('#f-cancel').addEventListener('click', async () => {
    if (editing) { home(); return; } // original step untouched
    const sure = await state.ctx.ui.modal('Discard this step? Its text and video are deleted.', ['KEEP EDITING', 'DISCARD STEP']);
    if (sure === 1) { await sync.deleteDraft(stepDraftId()); home(); }
  });
}

function keywords(callout) {
  const ws = callout.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOPWORDS.has(w));
  return ws.length ? ws.slice(0, 3) : [callout.toLowerCase()];
}

async function saveStep(d) {
  const title = d.title.trim();
  const instruction = d.instruction.trim();
  const callout = d.callout.trim();
  if (!title || !instruction || !callout) {
    await state.ctx.ui.modal('A step needs a title, an instruction, and a completion call-out before it can be saved.', ['OK']);
    return;
  }

  const editing = d.editIndex != null;
  const steps = state.doc.steps || (state.doc.steps = []);
  const prev = editing ? steps[d.editIndex] : null;
  const stepId = editing ? prev.step_id : 'S' + String(steps.length + 1).padStart(2, '0');
  const eq = d.equipment_id ? state.equipment.find((e) => e.id === d.equipment_id) : null;

  let videoRef = d.videoRef || null; // an existing clip survives unless replaced or removed
  if (d.videoBlob) {
    const ext = (d.videoType || '').includes('mp4') ? 'mp4' : 'webm';
    const path = `${state.uid}/${state.ctx.kcRef.id}/${stepId}-${Date.now()}.${ext}`;
    videoRef = 'vault:' + path;
    /* strip ';codecs=…' — the vault validates against plain mime types */
    const contentType = (d.videoType || 'video/webm').split(';')[0];
    await sync.enqueue('vault_upload', { path, content_type: contentType }, d.videoBlob);
  }

  const step = {
    step_id: stepId,
    title,
    critical: !!d.critical,
    equipment_id: eq ? eq.id : null,
    equipment_label: eq ? eq.name.toUpperCase() : null,
    instruction,
    phraseology: '', // filled by normalizeDoc
    required_callout: callout,
    callout_keywords: keywords(callout),
    critical_prerequisites: d.critical
      ? d.prereqs.split('\n').map((s) => s.trim()).filter(Boolean)
      : [],
    video: videoRef,
    failure_note: prev ? prev.failure_note : null
  };
  /* hand-authored extras (branching, alternate confirms) survive an edit */
  if (prev && prev.post_decision) step.post_decision = prev.post_decision;
  if (prev && prev.alternate_confirm) step.alternate_confirm = prev.alternate_confirm;

  if (editing) steps[d.editIndex] = step; else steps.push(step);
  normalizeDoc();
  await persistDoc();
  if (!editing) await sync.deleteDraft(stepDraftId());
  home();
}

/* After any add/edit/delete: renumber step ids to array order, remap branch
   targets through the old→new id map, regenerate builder-template phraseology
   (steps with custom phrasing — branches, alternate confirms, failure notes —
   keep theirs), and rebuild the Gate-0 label list from the remaining steps. */
function normalizeDoc() {
  const steps = state.doc.steps || [];
  const idMap = {};
  steps.forEach((s, i) => { idMap[s.step_id] = 'S' + String(i + 1).padStart(2, '0'); });
  steps.forEach((s, i) => {
    s.step_id = idMap[s.step_id];
    if (!(s.post_decision || s.alternate_confirm || s.failure_note)) {
      s.phraseology = `Step ${i + 1}. ${s.title}. ${s.instruction}${/[.!?]$/.test(s.instruction) ? '' : '.'} When complete, call out: ${s.required_callout}.`;
    }
    if (s.post_decision && s.post_decision.options) {
      s.post_decision.options = s.post_decision.options.filter((o) => idMap[o.goto]);
      s.post_decision.options.forEach((o) => { o.goto = idMap[o.goto]; });
      if (s.post_decision.options.length === 0) delete s.post_decision;
    }
  });
  state.doc.equipment_labels = [...new Set(steps.map((s) => s.equipment_label).filter(Boolean))];
}

async function persistDoc() {
  backend.cacheUpdateKC({
    id: state.ctx.kcRef.id, kc_type: state.ctx.kcRef.kc_type,
    title: state.doc.title, doc: state.doc, updated_at: new Date().toISOString()
  });
  await sync.enqueue('kc_doc_update', {
    kc_db_id: state.ctx.kcRef.id,
    doc: JSON.parse(JSON.stringify(state.doc))
  });
}

/* ---------------- equipment picker ---------------- */

function equipmentPicker(d) {
  state.view = 'picker';
  els.body.innerHTML = `
    <div class="gate-heading">Select equipment for step ${d.n}</div>
    <div class="builder-list" id="p-list"></div>
    <button class="btn btn-primary" id="p-new">+ NEW EQUIPMENT</button>
    <button class="btn btn-secondary" id="p-none">NO EQUIPMENT FOR THIS STEP</button>
    <button class="btn btn-tertiary" id="p-back">&#8592; BACK TO STEP</button>
  `;
  const list = els.body.querySelector('#p-list');
  if (state.equipment.length === 0) {
    list.innerHTML = '<p class="screen-sub">No equipment in the library yet — add the first item.</p>';
  }
  for (const eq of state.equipment) {
    const c = document.createElement('div');
    c.className = 'kc-card';
    c.innerHTML = `<h3>${escapeHtml(eq.name)}</h3>
      <div class="kc-meta">${escapeHtml(eq.description || '')}</div>`;
    c.addEventListener('click', () => { d.equipment_id = eq.id; persistDraft(d); stepForm(d); });
    list.appendChild(c);
  }
  els.body.querySelector('#p-new').onclick = () =>
    equipmentForm((eq) => { if (eq) { d.equipment_id = eq.id; persistDraft(d); } stepForm(d); });
  els.body.querySelector('#p-none').onclick = () => { d.equipment_id = null; persistDraft(d); stepForm(d); };
  els.body.querySelector('#p-back').onclick = () => stepForm(d);
}

/* ---------------- equipment capture (brief §2) ---------------- */

function equipmentForm(onDone, existing = null) {
  state.view = 'equipment';
  const d = existing
    ? {
        photoBlob: null, name: existing.name, description: existing.description || '',
        method: existing.identity_method, tag: existing.tag_value || ''
      }
    : { photoBlob: null, name: '', description: '', method: 'none', tag: '' };

  els.body.innerHTML = `
    <div class="gate-heading">${existing ? 'Edit equipment' : 'New equipment'}</div>
    <div class="screen-sub">Captured once — reusable in any step of any KC.</div>
    <div class="field">
      <label>Photo</label>
      <img id="e-thumb" class="eq-thumb" hidden alt="equipment photo">
      <button class="btn btn-secondary" id="e-photo">${existing && existing.photo_path ? 'RETAKE PHOTO' : 'TAKE PHOTO'}</button>
      <input id="e-file" type="file" accept="image/*" capture="environment" hidden>
    </div>
    <div class="field">
      <label for="e-name">Name</label>
      <input id="e-name" type="text" value="${escapeHtml(d.name)}" placeholder="e.g. Return Valve">
    </div>
    <div class="field">
      <label for="e-desc">Description — what it does / relevant context</label>
      <textarea id="e-desc" rows="3">${escapeHtml(d.description)}</textarea>
    </div>
    <div class="field">
      <label>How is this item identified on-site?</label>
      <label class="radio-item"><input type="radio" name="e-method" value="none" ${d.method === 'none' ? 'checked' : ''}><span>No tag — TECH confirms it by eye</span></label>
      <label class="radio-item"><input type="radio" name="e-method" value="plain_language_tag" ${d.method === 'plain_language_tag' ? 'checked' : ''}><span>Plain-language tag (a written label)</span></label>
      <label class="radio-item"><input type="radio" name="e-method" value="qr_nfc" ${d.method === 'qr_nfc' ? 'checked' : ''}><span>QR / NFC tag</span></label>
    </div>
    <div class="field" id="e-tag-field" ${d.method === 'none' ? 'hidden' : ''}>
      <label for="e-tag">Tag value</label>
      <input id="e-tag" type="text" value="${escapeHtml(d.tag)}" placeholder="the label text or QR/NFC payload">
      <button class="btn btn-secondary" id="e-scan" ${d.method === 'qr_nfc' && 'BarcodeDetector' in window ? '' : 'hidden'}>SCAN QR CODE</button>
    </div>
    <button class="btn btn-primary btn-big" id="e-save">${existing ? 'SAVE CHANGES' : 'SAVE EQUIPMENT'}</button>
    ${existing ? '<button class="btn btn-danger-ghost" id="e-delete">DELETE THIS EQUIPMENT</button>' : ''}
    <button class="btn btn-tertiary" id="e-cancel">CANCEL</button>
  `;

  const $ = (id) => els.body.querySelector(id);

  $('#e-photo').onclick = () => $('#e-file').click();
  $('#e-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    d.photoBlob = await downscalePhoto(file);
    if (d.photoBlob) {
      const t = $('#e-thumb');
      t.src = URL.createObjectURL(d.photoBlob);
      t.hidden = false;
      $('#e-photo').textContent = 'RETAKE PHOTO';
    }
  });
  $('#e-name').addEventListener('input', (e) => { d.name = e.target.value; });
  $('#e-desc').addEventListener('input', (e) => { d.description = e.target.value; });
  els.body.querySelectorAll('[name="e-method"]').forEach((r) => r.addEventListener('change', () => {
    d.method = r.value;
    $('#e-tag-field').hidden = d.method === 'none';
    $('#e-scan').hidden = !(d.method === 'qr_nfc' && 'BarcodeDetector' in window);
  }));
  $('#e-tag').addEventListener('input', (e) => { d.tag = e.target.value; });
  $('#e-scan').onclick = async () => {
    const value = await scanQR();
    if (value) { d.tag = value; $('#e-tag').value = value; }
  };

  $('#e-save').onclick = async () => {
    if (!d.name.trim()) {
      await state.ctx.ui.modal('Equipment needs at least a name.', ['OK']);
      return;
    }
    if (d.method !== 'none' && !d.tag.trim()) {
      await state.ctx.ui.modal('Enter the tag value, or choose "No tag".', ['OK']);
      return;
    }
    const id = existing ? existing.id : crypto.randomUUID();
    let photo_path = existing ? existing.photo_path : null;
    if (d.photoBlob) {
      photo_path = photo_path || `${state.uid}/equipment/${id}.jpg`;
      await sync.enqueue('vault_upload', { path: photo_path, content_type: 'image/jpeg' }, d.photoBlob);
    }
    const rec = {
      id, name: d.name.trim(), description: d.description.trim() || null,
      photo_path, identity_method: d.method,
      tag_value: d.method === 'none' ? null : d.tag.trim(),
      created_by: existing ? existing.created_by : (state.ctx.profileId || null)
    };
    const i = state.equipment.findIndex((e) => e.id === id);
    if (i >= 0) state.equipment[i] = rec; else state.equipment.push(rec);
    backend.cacheAddEquipment(rec);
    await sync.enqueue('equipment_upsert', rec);

    /* A rename must flow into this KC's steps and its Gate-0 label list. */
    if (existing && existing.name !== rec.name) {
      let touched = false;
      for (const s of state.doc.steps || []) {
        if (s.equipment_id === id) { s.equipment_label = rec.name.toUpperCase(); touched = true; }
      }
      if (touched) { normalizeDoc(); await persistDoc(); }
    }
    onDone(rec);
  };

  const eqDelete = $('#e-delete');
  if (eqDelete) eqDelete.onclick = async () => {
    const used = (state.doc.steps || []).filter((s) => s.equipment_id === existing.id).length;
    const sure = await state.ctx.ui.modal(
      used > 0
        ? `Delete "${existing.name}"? ${used} step${used === 1 ? '' : 's'} in this KC use${used === 1 ? 's' : ''} it — they will keep their text but lose the equipment link. This cannot be undone.`
        : `Delete "${existing.name}" from the equipment library? This cannot be undone.`,
      ['KEEP IT', 'DELETE EQUIPMENT']);
    if (sure !== 1) return;
    let touched = false;
    for (const s of state.doc.steps || []) {
      if (s.equipment_id === existing.id) {
        s.equipment_id = null; s.equipment_label = null; touched = true;
      }
    }
    if (touched) { normalizeDoc(); await persistDoc(); }
    state.equipment = state.equipment.filter((e) => e.id !== existing.id);
    backend.cacheRemoveEquipment(existing.id);
    await sync.enqueue('equipment_delete', { id: existing.id });
    onDone(null);
  };

  $('#e-cancel').onclick = () => onDone(null);
}

/* Downscale camera photos to ~1280px JPEG so equipment photos stay small. */
function downscalePhoto(file) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      c.toBlob((b) => resolve(b), 'image/jpeg', 0.82);
    };
    img.onerror = () => resolve(null);
    img.src = URL.createObjectURL(file);
  });
}

/* ---------------- in-app video capture ---------------- */

function pickMime() {
  if (!window.MediaRecorder) return null;
  return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    .find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

/* Records in-app at controlled quality (~1.2 Mbps video) instead of the phone's
   native camera app, which produces files 10× larger. */
function captureVideo() {
  return new Promise(async (resolve) => {
    const mime = pickMime();
    if (mime === null) {
      await state.ctx.ui.modal('This browser cannot record video in-app.', ['OK']);
      resolve(null);
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true
      });
    } catch {
      await state.ctx.ui.modal('Camera access was denied. Allow camera and microphone access for this app, then try again.', ['OK']);
      resolve(null);
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'capture-overlay';
    overlay.innerHTML = `
      <video id="cap-video" autoplay playsinline muted></video>
      <div class="rec-timer" id="cap-timer">0:00 / 2:00</div>
      <div class="rec-controls" id="cap-controls"></div>
    `;
    document.body.appendChild(overlay);
    const liveEl = overlay.querySelector('#cap-video');
    const timerEl = overlay.querySelector('#cap-timer');
    const controls = overlay.querySelector('#cap-controls');
    liveEl.srcObject = stream;

    let recorder = null;
    let chunks = [];
    let startedAt = 0;
    let tick = null;

    function cleanup() {
      if (tick) clearInterval(tick);
      stream.getTracks().forEach((t) => t.stop());
      overlay.remove();
    }
    function fmt(s) { return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }

    function idleControls() {
      controls.innerHTML = '';
      const rec = document.createElement('button');
      rec.className = 'btn btn-primary';
      rec.textContent = '● START RECORDING';
      rec.onclick = startRecording;
      const cancel = document.createElement('button');
      cancel.className = 'btn btn-secondary';
      cancel.textContent = 'CANCEL';
      cancel.onclick = () => { cleanup(); resolve(null); };
      controls.append(rec, cancel);
    }

    function startRecording() {
      chunks = [];
      recorder = new MediaRecorder(stream, mime
        ? { mimeType: mime, videoBitsPerSecond: 1_200_000, audioBitsPerSecond: 96_000 }
        : { videoBitsPerSecond: 1_200_000, audioBitsPerSecond: 96_000 });
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = () => {
        const seconds = (Date.now() - startedAt) / 1000;
        showPreview(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }), seconds);
      };
      recorder.start(1000);
      startedAt = Date.now();
      timerEl.classList.add('rec');
      tick = setInterval(() => {
        const s = (Date.now() - startedAt) / 1000;
        timerEl.textContent = `${fmt(s)} / ${fmt(MAX_CLIP_SECONDS)}`;
        if (s >= MAX_CLIP_SECONDS) stopRecording(); // hard cap
      }, 250);

      controls.innerHTML = '';
      const stop = document.createElement('button');
      stop.className = 'btn btn-primary';
      stop.textContent = '■ STOP';
      stop.onclick = stopRecording;
      controls.append(stop);
    }

    function stopRecording() {
      if (tick) { clearInterval(tick); tick = null; }
      timerEl.classList.remove('rec');
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    }

    function showPreview(blob, seconds) {
      stream.getTracks().forEach((t) => t.stop());
      const url = URL.createObjectURL(blob);
      liveEl.srcObject = null;
      liveEl.src = url;
      liveEl.muted = false;
      liveEl.controls = true;
      timerEl.textContent = `${fmt(seconds)} recorded`;

      controls.innerHTML = '';
      const use = document.createElement('button');
      use.className = 'btn btn-primary';
      use.textContent = 'USE THIS VIDEO';
      use.onclick = () => {
        URL.revokeObjectURL(url);
        overlay.remove();
        resolve({ blob, type: blob.type, seconds });
      };
      const retake = document.createElement('button');
      retake.className = 'btn btn-secondary';
      retake.textContent = 'RETAKE';
      retake.onclick = async () => {
        URL.revokeObjectURL(url);
        overlay.remove();
        resolve(await captureVideo()); // fresh stream + overlay
      };
      const cancel = document.createElement('button');
      cancel.className = 'btn btn-tertiary';
      cancel.textContent = 'CANCEL';
      cancel.onclick = () => { URL.revokeObjectURL(url); overlay.remove(); resolve(null); };
      controls.append(use, retake, cancel);
    }

    idleControls();
  });
}

/* ---------------- QR scan (Chrome on Android has BarcodeDetector) ---------------- */

function scanQR() {
  return new Promise(async (resolve) => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch {
      resolve(null);
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'capture-overlay';
    overlay.innerHTML = `
      <video id="scan-video" autoplay playsinline muted></video>
      <div class="rec-timer">Point the camera at the QR code</div>
      <div class="rec-controls"><button class="btn btn-secondary" id="scan-cancel">CANCEL</button></div>
    `;
    document.body.appendChild(overlay);
    const v = overlay.querySelector('#scan-video');
    v.srcObject = stream;

    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    let live = true;
    function cleanup(value) {
      live = false;
      stream.getTracks().forEach((t) => t.stop());
      overlay.remove();
      resolve(value);
    }
    overlay.querySelector('#scan-cancel').onclick = () => cleanup(null);

    const poll = setInterval(async () => {
      if (!live) { clearInterval(poll); return; }
      try {
        const codes = await detector.detect(v);
        if (codes.length) { clearInterval(poll); cleanup(codes[0].rawValue); }
      } catch { /* frame not ready yet */ }
    }, 400);
  });
}
