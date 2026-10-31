// KRS dashboard API: own username/password auth, admin user management,
// data access and xlsx ingest. All tables are RLS-locked; only this function
// (service role) reads or writes them.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import * as XLSX from "npm:xlsx@0.18.5";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const SESSION_DAYS = 7;
const PBKDF2_ITER = 100000;
const MAX_FAILS = 5;
const LOCK_MIN = 15;
const STATUSES = ["new", "research", "qualified", "contacted", "meeting", "not_relevant", "in_crm"];
const TOUCH_CHANNELS = ["call", "email", "linkedin", "messenger", "meeting", "visit", "note"];
const PRIORITIES = ["A", "B", "C", "partner"];
const ICP_VALUES = ["yes", "no", "check"];
const CLOSED = ["not_relevant", "in_crm"];
const INVITES = ["sent", "accepted", "declined"];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-session, x-ingest-key",
  "access-control-allow-methods": "POST, OPTIONS",
};

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
  });
}

// ---------- crypto ----------
const enc = new TextEncoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function sha256hex(s: string) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function pbkdf2(password: string, salt: Uint8Array, iter: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return new Uint8Array(bits);
}

async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(await pbkdf2(password, salt, PBKDF2_ITER))}`;
}

async function verifyPassword(password: string, stored: string) {
  const [alg, iter, salt, hash] = stored.split("$");
  if (alg !== "pbkdf2") return false;
  const got = await pbkdf2(password, unb64(salt), Number(iter));
  const want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

function randomToken(bytes = 32) {
  return b64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" }[c]!));
}

function checkPasswordPolicy(username: string, pw: string) {
  if (typeof pw !== "string" || pw.length < 10) throw new HttpError(400, "Пароль має містити щонайменше 10 символів");
  if (pw.toLowerCase() === username.toLowerCase() || pw.toLowerCase() === "admin") throw new HttpError(400, "Пароль занадто простий");
  if (!/[A-Za-zА-Яа-яІіЇїЄєҐґ]/.test(pw) || !/\d/.test(pw)) throw new HttpError(400, "Пароль має містити літери й цифри");
}

const normUser = (u: unknown) => String(u ?? "").trim().toLowerCase();

// ---------- sessions ----------
type User = { id: string; username: string; display_name: string | null; role: string; must_change: boolean; disabled: boolean };

async function sessionUser(req: Request): Promise<User | null> {
  const tok = req.headers.get("x-session");
  if (!tok) return null;
  const th = await sha256hex(tok);
  const { data } = await db.from("dash_sessions")
    .select("expires_at, dash_users(id, username, display_name, role, must_change, disabled)")
    .eq("token_hash", th).maybeSingle();
  if (!data || new Date(data.expires_at) < new Date()) return null;
  const u = data.dash_users as unknown as User;
  if (!u || u.disabled) return null;
  return u;
}

async function newSession(userId: string) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await db.from("dash_sessions").insert({ token_hash: await sha256hex(token), user_id: userId, expires_at: expires });
  await db.from("dash_sessions").delete().lt("expires_at", new Date().toISOString());
  return token;
}

const publicUser = (u: User) => ({ id: u.id, username: u.username, display_name: u.display_name, role: u.role, must_change: u.must_change });

// ---------- xlsx ingest ----------
// Header text (both sheet layouts) → canonical key. Unknown headers go to `extra`.
const HEADER_MAP: Record<string, string> = {
  "krs": "krs",
  "назва": "name", "компанія": "name",
  "дата реєстрації": "reg_date", "реєстрація": "reg_date",
  "місто": "city", "воєводство": "voivodeship",
  "стан krs": "krs_state", "форма": "legal_form",
  "nip": "nip", "regon": "regon", "капітал pln": "capital",
  "український власник": "ua_owner", "власник — громадянин україни": "ua_owner",
  "громадянство": "citizenship", "джерело громадянства": "citizenship_source",
  "тип володіння": "ownership_type", "володіння": "ownership_type",
  "частка": "share",
  "лпр": "dm", "роль лпр": "dm_role", "джерело лпр": "dm_source",
  "засновники та досвід": "founders", "засновники / досвід": "founders",
  "головний pkd": "pkd_main",
  "заявлена діяльність": "activity", "діяльність (заявлена pkd)": "activity",
  "фактичні продукти/послуги": "products", "фактична діяльність / аудиторія": "products",
  "сайт": "website", "сайт / відповідність юрособі": "website",
  "доказ відповідності сайту": "website_evidence",
  "b2b/b2c": "b2b_b2c",
  "географія": "geography", "масштаб / географія": "geography",
  "сигнали та масштаб": "signals",
  "новини й вакансії": "news", "сигнали / новини": "news",
  "обґрунтування": "rationale",
  "можливі it-потреби": "it_needs", "it-потреби — гіпотези": "it_needs",
  "наступний крок": "next_step",
  "джерела": "sources", "krs — джерело": "sources", "crbr — джерело": "sources_crbr",
  "дата перевірки": "checked_at", "перевірено": "checked_at",
  "дата telegram": "tg_date", "telegram — дата": "tg_date",
  "telegram message_id": "tg_msg_id",
  "статус sharepoint": "sync_status", "синхронізація": "sync_status",
  "ручні нотатки": "notes", "нотатки команди": "notes",
};
const DATE_KEYS = new Set(["reg_date", "checked_at", "tg_date"]);

function toIsoDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v.getTime())) {
    // SheetJS returns local-midnight dates; shift by 12h so the UTC day stays correct.
    return new Date(v.getTime() + 12 * 3600000).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

function clean(v: unknown) {
  if (v == null) return null;
  if (v instanceof Date) return toIsoDate(v);
  const s = String(v).replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

type Grids = Record<string, unknown[][]>;

function workbookGrids(buf: Uint8Array): Grids {
  const wb = XLSX.read(buf, { type: "array", cellDates: true, cellHTML: false, cellText: false, cellFormula: false });
  return Object.fromEntries(wb.SheetNames.map((n) => [n, XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[n], { header: 1, raw: true, defval: null })]));
}

function parseGrids(sheets: Grids) {
  const rows = new Map<string, { sheet: string; data: Record<string, unknown> }>();
  // Master sheet wins over the older profile layout for the same KRS.
  const order = Object.keys(sheets).sort((a, b) => (b.toLowerCase().includes("master") ? 1 : 0) - (a.toLowerCase().includes("master") ? 1 : 0));
  for (const sheetName of order) {
    const grid = sheets[sheetName];
    if (!Array.isArray(grid) || grid.length < 2) continue;
    const headers = (grid[0] as unknown[]).map((h) => String(h ?? "").trim());
    // The fit column's header carries a company name, so match it by its first word only.
    const keys = headers.map((h) => HEADER_MAP[h.toLowerCase()] ?? (/^відповідність(\s|$)/i.test(h) ? "src_fit" : null));
    if (!keys.includes("krs")) continue;
    for (const r of grid.slice(1)) {
      if (!Array.isArray(r)) continue;
      const d: Record<string, unknown> = {};
      const extra: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        const raw = (r as unknown[])[i];
        const k = keys[i];
        if (k && DATE_KEYS.has(k)) d[k] = toIsoDate(raw) ?? clean(raw);
        else if (k) d[k] = d[k] ? `${d[k]} | ${clean(raw) ?? ""}` : clean(raw);
        else if (h && raw != null && raw !== "") extra[h] = clean(raw);
      });
      if (d.sources_crbr) { d.sources = [d.sources, d.sources_crbr].filter(Boolean).join(" | "); delete d.sources_crbr; }
      const krsDigits = String(d.krs ?? "").replace(/\D/g, "");
      if (!krsDigits) continue;
      d.krs = krsDigits.padStart(10, "0");
      if (Object.keys(extra).length) d.extra = extra;
      if (!rows.has(d.krs as string)) rows.set(d.krs as string, { sheet: sheetName, data: d });
      else {
        // Fill gaps in the master row from the profile row.
        const cur = rows.get(d.krs as string)!.data;
        for (const [k, v] of Object.entries(d)) if (cur[k] == null && v != null) cur[k] = v;
      }
    }
  }
  return rows;
}

// PostgREST caps each response at 1000 rows, so read big tables page by page.
// The builder must apply a stable order so pages don't overlap.
async function selectAll(build: () => any, page = 1000) {
  const out: any[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await build().range(from, from + page - 1);
    if (error) throw new HttpError(500, error.message);
    out.push(...(data ?? []));
    if (!data || data.length < page) return { data: out };
  }
}

async function ingest(sheets: Grids, source: string) {
  const rows = parseGrids(sheets);
  if (rows.size === 0) throw new HttpError(400, "У файлі не знайдено аркушів з колонкою KRS");
  const { data: existing } = await selectAll(() => db.from("krs_companies").select("krs, content_hash, source_sheet").order("krs"));
  const ex = new Map((existing ?? []).map((e) => [e.krs, e]));
  const now = new Date().toISOString();
  const upserts: Record<string, unknown>[] = [];
  let inserted = 0, updated = 0;
  for (const [krs, { sheet, data }] of rows) {
    const h = await sha256hex(JSON.stringify(data));
    const old = ex.get(krs);
    if (!old) { inserted++; upserts.push({ krs, data, source_sheet: sheet, content_hash: h, first_seen_at: now, updated_at: now }); }
    else if (old.content_hash !== h || old.source_sheet === "removed") { updated++; upserts.push({ krs, data, source_sheet: sheet, content_hash: h, updated_at: now }); }
  }
  for (let i = 0; i < upserts.length; i += 200) {
    const { error } = await db.from("krs_companies").upsert(upserts.slice(i, i + 200), { onConflict: "krs" });
    if (error) throw new HttpError(500, error.message);
  }
  const removed = [...ex.keys()].filter((k) => !rows.has(k) && ex.get(k)!.source_sheet !== "removed");
  if (removed.length) await db.from("krs_companies").update({ source_sheet: "removed", updated_at: now }).in("krs", removed);
  const log = { source, total: rows.size, inserted, updated };
  await db.from("krs_sync_log").insert(log);
  return { ...log, removed: removed.length };
}

function decodeBase64(s: string) {
  return unb64(s.replace(/^data:.*?;base64,/, "").replace(/\s/g, ""));
}

// ---------- crediting ----------
// A company is credited when all seven conditions hold. app.js mirrors them in creditChecks(); keep both in step.
type Touch = { channel: string; meaningful: boolean; outcome: string | null; next_step: string | null; next_date: string | null };
function creditMet(work: Record<string, unknown> | null, contacts: { relevant: boolean }[], touches: Touch[]) {
  const real = touches.filter((t) => t.meaningful && t.channel !== "note");
  const last = touches[0];
  return work?.icp === "yes"
    && contacts.filter((c) => c.relevant).length >= 2
    && real.length >= 3
    && new Set(real.map((t) => t.channel)).size >= 2
    && real.some((t) => !!t.outcome)
    && (CLOSED.includes(String(work?.status)) || !!(last?.next_step && last?.next_date))
    && !!work?.proof;
}

// Stamps the crediting date the first time the conditions hold and clears it if they stop holding.
async function recomputeCredit(krs: string) {
  const [{ data: w }, { data: cs }, { data: ts }] = await Promise.all([
    db.from("krs_work").select("*").eq("krs", krs).maybeSingle(),
    db.from("krs_contacts").select("relevant").eq("krs", krs),
    db.from("krs_touches").select("channel, meaningful, outcome, next_step, next_date")
      .eq("krs", krs).order("touched_at", { ascending: false }).order("id", { ascending: false }),
  ]);
  if (!w) return null;
  const met = creditMet(w, cs ?? [], (ts ?? []) as Touch[]);
  let credited = w.credited_at;
  if (met && !credited) credited = new Date().toISOString().slice(0, 10);
  else if (!met && credited) credited = null;
  if (credited !== w.credited_at) await db.from("krs_work").update({ credited_at: credited }).eq("krs", krs);
  return { ...w, credited_at: credited };
}

const cut = (v: unknown, n: number) => (v == null || String(v).trim() === "" ? null : String(v).trim().slice(0, n));
const isKrs = (k: unknown) => /^\d{10}$/.test(String(k ?? ""));

async function readCycle() {
  const { data } = await db.from("dash_settings").select("value").eq("key", "cycle").maybeSingle();
  try { return data ? JSON.parse(data.value) : null; } catch { return null; }
}

// ---------- handlers ----------
async function handle(req: Request) {
  // Hourly sync: raw xlsx body + x-ingest-key header.
  const ingestKey = req.headers.get("x-ingest-key");
  if (ingestKey) {
    const { data } = await db.from("dash_settings").select("value").eq("key", "ingest_key_sha256").single();
    if (!data || (await sha256hex(ingestKey)) !== data.value) throw new HttpError(401, "Невірний ключ синхронізації");
    // The sync sends rows already read from the workbook ({sheets}); parsing a large xlsx here runs out of CPU time.
    const ct = req.headers.get("content-type") ?? "";
    if (!ct.includes("json")) return await ingest(workbookGrids(new Uint8Array(await req.arrayBuffer())), "auto");
    const b = await req.json();
    return await ingest(b.sheets ?? workbookGrids(decodeBase64(b.file_base64)), "auto");
  }

  const body = await req.json().catch(() => ({}));
  const action = body.action as string;

  if (action === "login") {
    const username = normUser(body.username);
    const { data: u } = await db.from("dash_users").select("*").eq("username", username).maybeSingle();
    const bad = new HttpError(401, "Невірний логін або пароль");
    if (!u) { await pbkdf2("x", new Uint8Array(16), PBKDF2_ITER); throw bad; }
    if (u.disabled) throw bad;
    if (u.locked_until && new Date(u.locked_until) > new Date()) throw new HttpError(429, "Забагато спроб. Спробуйте за 15 хвилин");
    if (!(await verifyPassword(String(body.password ?? ""), u.pass_hash))) {
      const fails = u.failed_count + 1;
      await db.from("dash_users").update({
        failed_count: fails >= MAX_FAILS ? 0 : fails,
        locked_until: fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MIN * 60000).toISOString() : null,
      }).eq("id", u.id);
      throw bad;
    }
    await db.from("dash_users").update({ failed_count: 0, locked_until: null, last_login_at: new Date().toISOString() }).eq("id", u.id);
    return { token: await newSession(u.id), user: publicUser(u) };
  }

  const user = await sessionUser(req);
  if (!user) throw new HttpError(401, "Сесія завершилась, увійдіть знову");

  if (action === "me") return { user: publicUser(user) };

  if (action === "logout") {
    await db.from("dash_sessions").delete().eq("token_hash", await sha256hex(req.headers.get("x-session")!));
    return { ok: true };
  }

  if (action === "change_password") {
    const { data: u } = await db.from("dash_users").select("pass_hash").eq("id", user.id).single();
    if (!(await verifyPassword(String(body.old_password ?? ""), u!.pass_hash))) throw new HttpError(400, "Поточний пароль невірний");
    checkPasswordPolicy(user.username, body.new_password);
    if (await verifyPassword(body.new_password, u!.pass_hash)) throw new HttpError(400, "Новий пароль має відрізнятися від поточного");
    await db.from("dash_users").update({ pass_hash: await hashPassword(body.new_password), must_change: false }).eq("id", user.id);
    // Drop every other session of this user.
    await db.from("dash_sessions").delete().eq("user_id", user.id).neq("token_hash", await sha256hex(req.headers.get("x-session")!));
    return { user: { ...publicUser(user), must_change: false } };
  }

  if (user.must_change) throw new HttpError(403, "Спершу змініть пароль");

  if (action === "data") {
    const [{ data: companies }, { data: work }, { data: users }, { data: syncs }, { data: touches }, { data: contacts }, cycle] = await Promise.all([
      selectAll(() => db.from("krs_companies").select("krs, data, source_sheet, first_seen_at, updated_at").order("krs")),
      selectAll(() => db.from("krs_work").select("*").order("krs")),
      db.from("dash_users").select("id, username, display_name").eq("disabled", false).order("created_at"),
      db.from("krs_sync_log").select("at, source, total, inserted, updated").order("at", { ascending: false }).limit(1),
      selectAll(() => db.from("krs_touches").select("id, krs, touched_at, channel, summary, outcome, next_step, next_date, author, author_id, meaningful, warm, discovery, qualified")
        .order("touched_at", { ascending: false }).order("id", { ascending: false })),
      selectAll(() => db.from("krs_contacts").select("krs, relevant").order("id")),
      readCycle(),
    ]);
    const w = new Map((work ?? []).map((x) => [x.krs, x]));
    // Per company: count, the latest touch, and the next step set by that latest touch.
    const t = new Map<string, { count: number; last: Record<string, unknown> }>();
    for (const x of touches ?? []) {
      const cur = t.get(x.krs);
      if (cur) cur.count++;
      else t.set(x.krs, { count: 1, last: x });
    }
    const dm = new Map<string, { total: number; relevant: number }>();
    for (const x of contacts ?? []) {
      const cur = dm.get(x.krs) ?? { total: 0, relevant: 0 };
      cur.total++;
      if (x.relevant) cur.relevant++;
      dm.set(x.krs, cur);
    }
    return {
      companies: (companies ?? []).map((c) => ({ ...c, work: w.get(c.krs) ?? null, touches: t.get(c.krs) ?? null, contacts: dm.get(c.krs) ?? null })),
      team: (users ?? []).map((u) => u.display_name || u.username),
      team_users: (users ?? []).map((u) => ({ id: u.id, name: u.display_name || u.username })),
      // Compact log of every touch for the cycle metrics; texts stay in the per-company call.
      touch_log: (touches ?? []).map((x) => ({
        krs: x.krs, at: x.touched_at, ch: x.channel, au: x.author, auid: x.author_id,
        m: x.meaningful && x.channel !== "note", w: x.warm, d: x.discovery, q: x.qualified, o: x.outcome,
      })),
      cycle,
      last_sync: syncs?.[0] ?? null,
    };
  }

  if (action === "set_work") {
    const krs = String(body.krs ?? "");
    if (!isKrs(krs)) throw new HttpError(400, "Невірний KRS");
    const patch: Record<string, unknown> = { krs, updated_by: user.display_name || user.username, updated_at: new Date().toISOString() };
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) throw new HttpError(400, "Невірний статус");
      patch.status = body.status;
    }
    if (body.priority !== undefined) {
      if (body.priority !== "" && !PRIORITIES.includes(body.priority)) throw new HttpError(400, "Невірний пріоритет");
      patch.priority = body.priority || null;
    }
    if (body.icp !== undefined) {
      if (body.icp !== "" && !ICP_VALUES.includes(body.icp)) throw new HttpError(400, "Невірне значення ICP");
      patch.icp = body.icp || null;
    }
    if (body.cycle_month !== undefined) {
      const m = body.cycle_month === "" || body.cycle_month == null ? null : Number(body.cycle_month);
      if (m !== null && ![1, 2, 3].includes(m)) throw new HttpError(400, "Місяць циклу: 1, 2 або 3");
      patch.cycle_month = m;
    }
    for (const k of ["owner", "segment"]) if (body[k] !== undefined) patch[k] = cut(body[k], 120);
    for (const k of ["note", "blocker", "proof"]) if (body[k] !== undefined) patch[k] = cut(body[k], 4000);
    const { error } = await db.from("krs_work").upsert(patch, { onConflict: "krs" });
    if (error) throw new HttpError(500, error.message);
    return { work: await recomputeCredit(krs) };
  }

  if (action === "touches") {
    const krs = String(body.krs ?? "");
    const { data } = await db.from("krs_touches").select("*").eq("krs", krs).order("touched_at", { ascending: false });
    return { touches: data ?? [] };
  }

  if (action === "contacts") {
    const { data } = await db.from("krs_contacts").select("*").eq("krs", String(body.krs ?? "")).order("created_at");
    return { contacts: data ?? [] };
  }

  if (action === "save_contact") {
    const krs = String(body.krs ?? "");
    if (!isKrs(krs)) throw new HttpError(400, "Невірний KRS");
    const fullName = cut(body.full_name, 160);
    if (!fullName) throw new HttpError(400, "Вкажіть ім'я контакту");
    const linkedin = cut(body.linkedin, 300);
    if (linkedin && !/^https?:\/\//i.test(linkedin)) throw new HttpError(400, "LinkedIn: повне посилання з https://");
    const row: Record<string, unknown> = {
      krs, full_name: fullName, position: cut(body.position, 160), relevant: body.relevant !== false,
      email: cut(body.email, 200), phone: cut(body.phone, 60), linkedin, language: cut(body.language, 20),
      source: cut(body.source, 160), invite: INVITES.includes(body.invite) ? body.invite : null, note: cut(body.note, 2000),
      updated_at: new Date().toISOString(),
    };
    if (body.id) {
      const { data: old } = await db.from("krs_contacts").select("krs").eq("id", Number(body.id)).maybeSingle();
      if (!old || old.krs !== krs) throw new HttpError(404, "Контакт не знайдено");
      await db.from("krs_contacts").update(row).eq("id", Number(body.id));
      // Touches show the contact by name, so keep the name in step.
      await db.from("krs_touches").update({ contact: fullName }).eq("contact_id", Number(body.id));
    } else {
      const { error } = await db.from("krs_contacts").insert({ ...row, created_by: user.display_name || user.username, created_by_id: user.id });
      if (error) throw new HttpError(500, error.message);
    }
    return { work: await recomputeCredit(krs) };
  }

  if (action === "delete_contact") {
    const { data: ct } = await db.from("krs_contacts").select("krs, created_by_id").eq("id", Number(body.id)).maybeSingle();
    if (!ct) throw new HttpError(404, "Контакт не знайдено");
    if (ct.created_by_id !== user.id && user.role !== "admin") throw new HttpError(403, "Видаляти можна лише власні контакти");
    await db.from("krs_contacts").delete().eq("id", Number(body.id));
    return { work: await recomputeCredit(ct.krs) };
  }

  if (action === "add_touch") {
    const krs = String(body.krs ?? "");
    if (!isKrs(krs)) throw new HttpError(400, "Невірний KRS");
    const summary = String(body.summary ?? "").trim();
    if (!summary) throw new HttpError(400, "Опишіть, що було під час дотику");
    const channel = TOUCH_CHANNELS.includes(body.channel) ? body.channel : "note";
    const touchedAt = body.touched_at ? new Date(body.touched_at) : new Date();
    if (isNaN(touchedAt.getTime()) || touchedAt.getTime() > Date.now() + 86400000) throw new HttpError(400, "Невірна дата дотику");
    const nextDate = body.next_date ? String(body.next_date) : null;
    if (nextDate && !/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) throw new HttpError(400, "Невірна дата наступного кроку");
    let contactId: number | null = null, contactName = cut(body.contact, 200);
    if (body.contact_id) {
      const { data: ct } = await db.from("krs_contacts").select("id, krs, full_name").eq("id", Number(body.contact_id)).maybeSingle();
      if (!ct || ct.krs !== krs) throw new HttpError(400, "Контакт не належить цій компанії");
      contactId = ct.id; contactName = ct.full_name;
    }
    const meaningful = channel !== "note" && body.meaningful !== false;
    const { data, error } = await db.from("krs_touches").insert({
      krs, channel, touched_at: touchedAt.toISOString(),
      direction: body.direction === "in" || body.direction === "out" ? body.direction : null,
      contact: contactName, contact_id: contactId, summary: summary.slice(0, 4000), outcome: cut(body.outcome, 40),
      next_step: cut(body.next_step, 1000), next_date: nextDate,
      meaningful, warm: meaningful && !!body.warm, discovery: meaningful && !!body.discovery, qualified: meaningful && !!body.qualified,
      author: user.display_name || user.username, author_id: user.id,
    }).select().single();
    if (error) throw new HttpError(500, error.message);
    return { touch: data, work: await recomputeCredit(krs) };
  }

  if (action === "delete_touch") {
    const { data: t } = await db.from("krs_touches").select("krs, author_id").eq("id", Number(body.id)).maybeSingle();
    if (!t) throw new HttpError(404, "Запис не знайдено");
    if (t.author_id !== user.id && user.role !== "admin") throw new HttpError(403, "Видаляти можна лише власні записи");
    await db.from("krs_touches").delete().eq("id", Number(body.id));
    return { ok: true, work: await recomputeCredit(t.krs) };
  }

  // ---------- admin ----------
  if (user.role !== "admin") throw new HttpError(403, "Лише для адміністратора");

  if (action === "list_users") {
    const { data } = await db.from("dash_users")
      .select("id, username, display_name, role, must_change, disabled, last_login_at, created_at, created_by, locked_until")
      .order("created_at");
    return { users: data };
  }

  if (action === "create_user") {
    const username = normUser(body.username);
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new HttpError(400, "Логін: 3–40 символів, латиниця, цифри, . _ -");
    checkPasswordPolicy(username, body.password);
    const role = body.role === "admin" ? "admin" : "user";
    const { error } = await db.from("dash_users").insert({
      username, display_name: String(body.display_name || username).slice(0, 80), role,
      pass_hash: await hashPassword(body.password), must_change: true, created_by: user.username,
    });
    if (error) throw new HttpError(400, error.code === "23505" ? "Такий логін уже існує" : error.message);
    return { ok: true };
  }

  if (action === "update_user") {
    const id = String(body.id ?? "");
    const { data: target } = await db.from("dash_users").select("*").eq("id", id).single();
    if (!target) throw new HttpError(404, "Користувача не знайдено");
    const patch: Record<string, unknown> = {};
    if (body.password) {
      checkPasswordPolicy(target.username, body.password);
      patch.pass_hash = await hashPassword(body.password);
      patch.must_change = true;
      patch.failed_count = 0;
      patch.locked_until = null;
    }
    if (body.role !== undefined) patch.role = body.role === "admin" ? "admin" : "user";
    if (body.disabled !== undefined) patch.disabled = !!body.disabled;
    if (body.display_name !== undefined) {
      const name = String(body.display_name).trim().slice(0, 80);
      if (!name) throw new HttpError(400, "Ім'я не може бути порожнім");
      patch.display_name = name;
    }
    if (id === user.id && (patch.role === "user" || patch.disabled)) throw new HttpError(400, "Не можна зняти права або заблокувати себе");
    await db.from("dash_users").update(patch).eq("id", id);
    // Assignments and touch authors store the visible name, so carry them over to the new one.
    const oldName = target.display_name || target.username;
    if (patch.display_name && patch.display_name !== oldName) {
      await db.from("krs_work").update({ owner: patch.display_name }).eq("owner", oldName);
      await db.from("krs_touches").update({ author: patch.display_name }).eq("author_id", id);
    }
    if (body.password || patch.disabled) await db.from("dash_sessions").delete().eq("user_id", id);
    return { ok: true };
  }

  if (action === "delete_user") {
    if (body.id === user.id) throw new HttpError(400, "Не можна видалити себе");
    await db.from("dash_users").delete().eq("id", String(body.id ?? ""));
    return { ok: true };
  }

  if (action === "set_cycle") {
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    if (!iso.test(body.start ?? "") || !iso.test(body.end ?? "") || body.start > body.end) throw new HttpError(400, "Перевірте межі циклу");
    const num = (v: unknown) => Math.max(0, Math.min(100000, Math.round(Number(v) || 0)));
    const targets: Record<string, number> = {};
    for (const k of ["companies", "touches", "warm", "discovery", "qualified", "credited"]) targets[k] = num(body.targets?.[k]);
    const { data: ids } = await db.from("dash_users").select("id");
    const plan: Record<string, number> = {};
    for (const { id } of ids ?? []) if (body.plan?.[id] !== undefined) plan[id] = num(body.plan[id]);
    const cycle = { start: body.start, end: body.end, targets, plan };
    await db.from("dash_settings").upsert({ key: "cycle", value: JSON.stringify(cycle) });
    return { cycle };
  }

  if (action === "sync_log") {
    const { data } = await db.from("krs_sync_log").select("*").order("at", { ascending: false }).limit(50);
    return { log: data };
  }

  if (action === "upload_xlsx") {
    return await ingest(body.sheets ?? workbookGrids(decodeBase64(String(body.file_base64 ?? ""))), `manual:${user.username}`);
  }

  if (action === "rotate_ingest_key") {
    const key = randomToken();
    await db.from("dash_settings").upsert({ key: "ingest_key_sha256", value: await sha256hex(key) });
    return { ingest_key: key };
  }

  throw new HttpError(400, "Невідома дія");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    return json(await handle(req));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Внутрішня помилка" }, 500);
  }
});
