/* LT v0.3 — Supabase backend: enterprise auth, profiles, KC library, offline cache.
   One auth account = one enterprise. Profiles are people within it (no separate
   logins). Each KC's full body lives in the `doc` jsonb column — the same JSON
   format as the original kc/pool-cleaning.json.

   Every list call returns { data, offline }: fresh from the network when
   possible, otherwise the last copy cached on this phone, so a signed-in phone
   keeps working in the field with no reception. */

const SUPABASE_URL = 'https://cokzpmtqhejefcevvfhg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_WaPqCeQna6jfuyxL9CfDlg_NaArWsg0';

const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* ---------------- local cache ---------------- */

const CACHE = {
  enterprise: 'lt_cache_enterprise',
  profiles: 'lt_cache_profiles',
  kcs: 'lt_cache_kcs',
  equipment: 'lt_cache_equipment',
  lastProfile: 'lt_last_profile'
};

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function cacheSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full — cache is best-effort */ }
}

function clearCache() {
  Object.values(CACHE).forEach((k) => localStorage.removeItem(k));
}

/* Network-first with cache fallback. */
async function fetchOrCache(cacheKey, fetcher) {
  try {
    const data = await fetcher();
    cacheSet(cacheKey, data);
    return { data, offline: false };
  } catch {
    return { data: cacheGet(cacheKey), offline: true };
  }
}

/* ---------------- auth ---------------- */

export async function getSession() {
  const { data } = await client.auth.getSession();
  return data.session || null;
}

export async function signIn(email, password) {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

/* Creates the account; the enterprise row is created automatically by a
   database trigger from the enterprise_name metadata. With email confirmation
   on, no session is returned until the emailed link is tapped. */
export async function signUp(email, password, enterpriseName) {
  const { data, error } = await client.auth.signUp({
    email, password,
    options: { data: { enterprise_name: enterpriseName } }
  });
  if (error) throw error;
  return { session: data.session, needsConfirmation: !data.session };
}

/* Federated login. Redirects to the provider and back; on return, supabase-js
   picks the session out of the URL automatically during boot. */
export async function signInWithGoogle() {
  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin + location.pathname }
  });
  if (error) throw error;
}

export async function signOut() {
  clearCache();
  await client.auth.signOut();
}

/* ---------------- enterprise + profiles ---------------- */

export function getEnterprise() {
  return fetchOrCache(CACHE.enterprise, async () => {
    const { data, error } = await client.from('enterprises').select('id, name').single();
    if (error) throw error;
    return data;
  });
}

export function listProfiles() {
  return fetchOrCache(CACHE.profiles, async () => {
    const { data, error } = await client.from('profiles')
      .select('id, display_name').order('created_at');
    if (error) throw error;
    return data;
  });
}

export async function renameProfile(id, displayName) {
  const { data, error } = await client.from('profiles')
    .update({ display_name: displayName }).eq('id', id)
    .select('id, display_name').single();
  if (error) throw error;
  return data;
}

export async function createProfile(displayName) {
  const { data, error } = await client.from('profiles')
    .insert({ display_name: displayName, enterprise_id: (await getSession()).user.id })
    .select('id, display_name').single();
  if (error) throw error;
  return data;
}

/* Federated sign-ups get the placeholder name 'My Enterprise' from the
   database trigger; the app prompts for the real name on first arrival. */
export async function renameEnterprise(name) {
  const { data, error } = await client.from('enterprises')
    .update({ name }).eq('id', (await getSession()).user.id)
    .select('id, name').single();
  if (error) throw error;
  cacheSet(CACHE.enterprise, data);
  return data;
}

export function rememberProfile(profile) { cacheSet(CACHE.lastProfile, profile); }
export function lastProfile() { return cacheGet(CACHE.lastProfile); }

/* ---------------- knowledge containers ---------------- */

export function listKCs() {
  return fetchOrCache(CACHE.kcs, async () => {
    const { data, error } = await client.from('kcs')
      .select('id, kc_type, title, doc, updated_at').order('created_at');
    if (error) throw error;
    return data;
  });
}

export async function createKC({ title, kcType, doc, createdBy }) {
  const { data, error } = await client.from('kcs')
    .insert({
      title, kc_type: kcType, doc, created_by: createdBy || null,
      enterprise_id: (await getSession()).user.id
    })
    .select('id, kc_type, title, doc, updated_at').single();
  if (error) throw error;
  return data;
}

export async function renameKC(id, title, doc) {
  const { data, error } = await client.from('kcs')
    .update({ title, doc })
    .eq('id', id)
    .select('id, kc_type, title, doc, updated_at').single();
  if (error) throw error;
  return data;
}

/* Deletes the KC row and best-effort cleans its videos out of the vault.
   Online-only (like create/rename). */
export async function deleteKC(id) {
  const { error } = await client.from('kcs').delete().eq('id', id);
  if (error) throw error;
  try {
    const uid = (await getSession()).user.id;
    const folder = `${uid}/${id}`;
    const { data: files } = await client.storage.from('kc-videos').list(folder, { limit: 100 });
    if (files && files.length) {
      await client.storage.from('kc-videos').remove(files.map((f) => `${folder}/${f.name}`));
    }
  } catch { /* orphaned files are invisible to users; cleanup is best-effort */ }
}

export function cacheRemoveKC(id) {
  cacheSet(CACHE.kcs, (cacheGet(CACHE.kcs) || []).filter((r) => r.id !== id));
}

/* The step builder edits the doc locally first; this pushes the whole
   document (idempotent — the newest doc always wins). */
export async function saveKCDoc(kcDbId, doc) {
  const { error } = await client.from('kcs').update({ doc, title: doc.title }).eq('id', kcDbId);
  if (error) throw error;
}

/* Keep the offline KC cache truthful after local (not-yet-synced) edits,
   so a restart in the field still shows the author's work. */
export function cacheUpdateKC(row) {
  const rows = cacheGet(CACHE.kcs) || [];
  const i = rows.findIndex((r) => r.id === row.id);
  if (i >= 0) rows[i] = row; else rows.push(row);
  cacheSet(CACHE.kcs, rows);
}

/* ---------------- equipment library ---------------- */

export function listEquipment() {
  return fetchOrCache(CACHE.equipment, async () => {
    const { data, error } = await client.from('equipment')
      .select('id, name, description, photo_path, identity_method, tag_value')
      .order('created_at');
    if (error) throw error;
    return data;
  });
}

/* Idempotent by client-generated id: retries never duplicate. */
export async function upsertEquipment(rec) {
  const { error } = await client.from('equipment')
    .upsert({ ...rec, enterprise_id: (await getSession()).user.id }, { onConflict: 'id' });
  if (error) throw error;
}

/* Idempotent delete: removing an already-removed record is a no-op. */
export async function deleteEquipment(id) {
  const { error } = await client.from('equipment').delete().eq('id', id);
  if (error) throw error;
}

export function cacheAddEquipment(rec) {
  const rows = cacheGet(CACHE.equipment) || [];
  const i = rows.findIndex((r) => r.id === rec.id);
  if (i >= 0) rows[i] = rec; else rows.push(rec);
  cacheSet(CACHE.equipment, rows);
}

export function cacheRemoveEquipment(id) {
  cacheSet(CACHE.equipment, (cacheGet(CACHE.equipment) || []).filter((r) => r.id !== id));
}

/* ---------------- video/photo vault ---------------- */

export async function userId() {
  const s = await getSession();
  return s ? s.user.id : null;
}

/* Idempotent by path (upsert): retries overwrite, never duplicate. */
export async function uploadToVault(path, blob, contentType) {
  const { error } = await client.storage.from('kc-videos')
    .upload(path, blob, { upsert: true, contentType });
  if (error) throw error;
}

/* Steps reference vault media as 'vault:<path>'. Resolve to a temporary
   signed URL for playback; bundled clips (clips/…) pass through unchanged. */
export async function mediaUrl(ref) {
  if (!ref || !ref.startsWith('vault:')) return ref;
  const { data, error } = await client.storage.from('kc-videos')
    .createSignedUrl(ref.slice(6), 3600);
  if (error) throw error;
  return data.signedUrl;
}
