"use strict";
// KRS Radar — dashboard over Companies_KRS_dataset (new Polish companies with Ukrainian owners).
// Data and accounts live behind the krs-api edge function; nothing sensitive ships with this page.

const API = "https://aikyzkiyfgctyklfopzy.supabase.co/functions/v1/krs-api";
const TOKEN_KEY = "krs_radar_token";
const REFRESH_MS = 5 * 60 * 1000;

const STATUS = {
  new: "Не опрацьовано",
  research: "Дослідження",
  qualified: "Кваліфіковано",
  contacted: "Контакт",
  meeting: "Зустріч",
  not_relevant: "Не релевантно",
  in_crm: "Передано в CRM",
};
const PRIORITY = { A: "A", B: "B", C: "C", partner: "Партнер / канал" };
const ICP = { yes: "Так", no: "Ні", check: "Уточнити" };
const SEGMENTS = [
  "Виробництво / промисловість", "Харчова промисловість / FMCG", "Логістика і транспорт", "Роздріб / e-commerce", "HoReCa",
  "Будівництво / нерухомість", "Медицина", "Освіта", "Професійні послуги", "Краса / велнес", "Енергетика / трейдинг",
  "Держава / інституції", "Медіа / фінтех", "Оборонка", "IT / аутсорсинг", "IT-продукт / SaaS", "IT-інфраструктура", "Інше",
];
const INVITE = { sent: "Запрошення надіслано", accepted: "Запрошення прийнято", declined: "Запрошення відхилено" };
const LANGS = ["UA", "PL", "EN", "UA/PL", "UA/EN"];
const CLOSED = ["not_relevant", "in_crm"];
const TOUCH_FLAGS = { warm: "Теплий", discovery: "Discovery", qualified: "Кваліфіковано" };
const CHANNELS = { call: "Дзвінок", email: "Email", linkedin: "LinkedIn", messenger: "Месенджер", meeting: "Зустріч", visit: "Візит", note: "Нотатка" };
const OUTCOMES = {
  no_answer: "Без відповіді", interested: "Зацікавлені", follow_up: "Повернутися пізніше", meeting_set: "Призначено зустріч",
  offer_sent: "Надіслано пропозицію", not_interested: "Не зацікавлені", wrong_contact: "Не той контакт",
};
const FIT_ORDER = ["Висока", "Середня", "Низька"];
// Level bands of the single fit score.
const levelOf = (t) => (t >= 60 ? "Висока" : t >= 40 ? "Середня" : "Низька");
const FIT_CLASS = { "Висока": "hi", "Середня": "mid", "Низька": "lo" };

// PKD 2007 divisions → sector groups.
const SECTORS = [
  [[62, 63], "IT та програмування"],
  [[58, 61], "Медіа й телеком"],
  [[10, 33], "Виробництво"],
  [[35, 39], "Енергетика й комунальні"],
  [[41, 43], "Будівництво"],
  [[45, 47], "Торгівля"],
  [[49, 53], "Транспорт і логістика"],
  [[55, 56], "HoReCa"],
  [[64, 66], "Фінанси й страхування"],
  [[68, 68], "Нерухомість"],
  [[69, 75], "Професійні послуги"],
  [[77, 82], "Адмін. послуги, кадри, клінінг"],
  [[84, 84], "Державний сектор"],
  [[85, 85], "Освіта"],
  [[86, 88], "Медицина й соцдопомога"],
  [[90, 93], "Культура й розваги"],
  [[94, 96], "Інші послуги"],
  [[1, 9], "Агро й видобування"],
];
// Industry weight in the fit score. 25 = the target industries
// (finance, logistics, manufacturing, public sector, healthcare, retail). IT companies get 0:
// they are partners or competitors, not clients.
const SECTOR_WEIGHT = {
  "Виробництво": 25, "Транспорт і логістика": 25, "Фінанси й страхування": 25, "Медицина й соцдопомога": 25,
  "Торгівля": 25, "Державний сектор": 25,
  "Професійні послуги": 12, "Енергетика й комунальні": 12,
  "Медіа й телеком": 10, "HoReCa": 10, "Освіта": 10,
  "Будівництво": 6, "Адмін. послуги, кадри, клінінг": 6, "Нерухомість": 6,
};
// PKD divisions whose business cannot run without a physical site (plant, warehouse, store, clinic, base).
const SITE_DIVISIONS = new Set([...Array.from({ length: 24 }, (_, i) => 10 + i), 45, 46, 49, 52, 55, 56, 84, 86, 87]);
const SITE_RE = /склад|магазин|торгов\S* точк|виробнич|виробництв|цех|завод|фабрик|майданчик|офіс(?!н\S* підтримк)|філі|локаці|автопарк|\bпарк\b|диспетчер|клінік|ресторан|готел|обсмажуван|warehouse|plant|store|office/i;
// "Заявлено …" and "Головний профіль …" restate the PKD list, so they are not evidence either.
const NEG_RE = /не підтвердж|не знайдено|немає|без підтвердж|невідом|заявлен|головний профіль|гіпотез|можлив|not confirmed/i;
const SCALE_RE = /виручк|оборот|млн pln|активів|revenue/i;
const TEAM_RE = /ваканс|команд|працівник|співробітник|employees/i;

// Clauses of the free-text fields that state something as confirmed (not "не підтверджено …").
function confirmedClauses(...texts) {
  return texts.filter(known).join("; ").split(/;|\.\s/).map((s) => s.trim()).filter((s) => s && !NEG_RE.test(s));
}

const state = {
  token: null,
  user: null,
  view: "overview",
  data: [],
  team: [],
  teamUsers: [],
  touchLog: [],
  touchAgg: new Map(),
  cycle: null,
  lastSync: null,
  loadedAt: null,
  filters: defaultFilters(),
  sort: { key: "score", dir: -1 },
  openKrs: null,
  admin: { users: [], log: [], msg: "", key: "" },
  filtersOpen: false,
};

function defaultFilters() {
  return { q: "", fit: [], voiv: [], sector: [], status: [], owner: [], prio: [], segment: [], from: "", to: "", flags: [], showRemoved: false };
}

// ---------- utils ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const NA_RE = /^(не підтверджено|не перевірено|не знайдено|немає|—|-|n\/a)/i;
const known = (v) => v != null && String(v).trim() !== "" && !NA_RE.test(String(v).trim());
const shown = (v) => (known(v) ? esc(v) : `<span class="faint">${esc(v || "—")}</span>`);
const fmtDate = (iso) => (iso ? new Date(iso.length === 10 ? iso + "T12:00:00" : iso).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—");
const fmtDT = (iso) => (iso ? new Date(iso).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const today = () => { const d = new Date(); d.setHours(12, 0, 0, 0); return d; };
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const daysSince = (iso) => (iso ? Math.round((today() - new Date(iso + "T12:00:00")) / 86400000) : null);
const titleCase = (s) => String(s || "").toLowerCase().replace(/(^|[\s\-(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
const shortName = (n) => String(n || "").replace(/\s+SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ/i, " Sp. z o.o.").replace(/\s+SPÓŁKA AKCYJNA/i, " S.A.").replace(/\s{2,}/g, " ").trim();

function tokenGet() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
function tokenSet(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ } }

async function api(action, payload = {}) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", ...(state.token ? { "x-session": state.token } : {}) },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await res.json().catch(() => ({ error: "Немає відповіді сервера" }));
  if (res.status === 401 && action !== "login" && action !== "change_password") { logoutLocal(); throw new Error(body.error); }
  if (!res.ok) throw new Error(body.error || `Помилка ${res.status}`);
  return body;
}

// ---------- enrichment ----------
function pkdInfo(pkd, activity) {
  const m = String(pkd || activity || "").match(/(\d{2})\.(\d{2})\.?([A-Z])?/);
  if (!m) return { code: null, division: null, sector: "Невідомо" };
  const div = Number(m[1]);
  const hit = SECTORS.find(([[a, b]]) => div >= a && div <= b);
  return { code: `${m[1]}.${m[2]}${m[3] ? "." + m[3] : ""}`, division: div, sector: hit ? hit[1] : "Інше" };
}

function websiteUrl(w) {
  const m = String(w || "").match(/https?:\/\/[^\s|;,]+/i) || String(w || "").match(/\b([a-z0-9-]+\.)+(pl|com|eu|ua|net|org|io|de)\b[^\s|;,]*/i);
  if (!m) return null;
  return m[0].startsWith("http") ? m[0] : "https://" + m[0];
}

function parseOwners(s) {
  if (!known(s)) return [];
  return String(s).split(/;|\|/).map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = x.match(/^(.*?)\s*[—–-]\s*(\d+(?:[.,]\d+)?)\s*%/);
    return m ? { name: m[1].trim(), pct: Number(m[2].replace(",", ".")) } : { name: x, pct: null };
  }).filter((o) => /^\p{Lu}[\p{L}'’.-]+(\s+\p{Lu}[\p{L}'’.-]+){1,3}$/u.test(o.name));
}

function capitalNum(s) {
  const n = Number(String(s || "").replace(/\s/g, "").replace(",", "."));
  return isFinite(n) && n > 0 ? n : null;
}

// The one fit score (0–100): a company opening a physical site in Poland, in a target industry,
// inside the launch window. Built only from fields in the dataset.
function scoreOf(c) {
  const d = c.d;
  const parts = [];
  const facts = confirmedClauses(d.products, d.signals, d.news, d.geography);

  // Physical site, up to 30.
  const siteFact = facts.find((s) => SITE_RE.test(s));
  if (siteFact) parts.push(["Підтверджений фізичний об'єкт", 30]);
  else if (SITE_DIVISIONS.has(c.division) || (c.division === 47 && !String(c.pkd).startsWith("47.91"))) parts.push(["Галузь із фізичним об'єктом (за PKD)", 15]);

  // Target industries, up to 25.
  const sw = SECTOR_WEIGHT[c.sector] || 0;
  if (sw) parts.push([`Галузь: ${c.sector}`, sw]);

  // Launch window, up to 20.
  if (c.age != null && c.age <= 30) parts.push(["Реєстрація ≤30 дн. — вікно запуску", 20]);
  else if (c.age != null && c.age <= 90) parts.push(["Реєстрація ≤90 дн.", 10]);

  // Scale, up to 15.
  let scale = 0;
  if (facts.some((s) => SCALE_RE.test(s))) scale += 8;
  if (facts.some((s) => TEAM_RE.test(s))) scale += 5;
  if (c.capital >= 100000) scale += 5;
  else if (c.capital >= 50000) scale += 3;
  if (scale) parts.push(["Масштаб: виручка, команда, капітал", Math.min(15, scale)]);

  // Reachability, up to 10.
  if (known(d.dm)) parts.push(["Відомий ЛПР", 5]);
  if (c.site) parts.push(["Підтверджений сайт", 5]);

  const total = Math.min(100, parts.reduce((a, [, p]) => a + p, 0));
  return { total, parts };
}

function enrich(row) {
  const d = row.data || {};
  const pk = pkdInfo(d.pkd_main, d.activity);
  const c = {
    krs: row.krs,
    d,
    work: row.work || null,
    name: shortName(d.name),
    city: titleCase(d.city),
    voiv: d.voivodeship ? String(d.voivodeship).toUpperCase() : "Невідомо",
    reg: /^\d{4}-\d{2}-\d{2}$/.test(d.reg_date || "") ? d.reg_date : null,
    pkd: pk.code,
    sector: pk.sector,
    division: pk.division,
    site: websiteUrl(d.website),
    owners: parseOwners(d.ua_owner || d.share),
    capital: capitalNum(d.capital),
    firstSeen: row.first_seen_at,
    updatedAt: row.updated_at,
    removed: row.source_sheet === "removed",
    status: row.work?.status || "new",
    owner: row.work?.owner || "",
    touchCount: row.touches?.count || 0,
    lastTouch: row.touches?.last || null,
    priority: row.work?.priority || "",
    segment: row.work?.segment || "",
    icp: row.work?.icp || "",
    cycleMonth: row.work?.cycle_month || null,
    blocker: row.work?.blocker || "",
    proof: row.work?.proof || "",
    credited: row.work?.credited_at || null,
    dmCount: row.contacts?.relevant || 0,
    contactCount: row.contacts?.total || 0,
    agg: state.touchAgg.get(row.krs) || { m: 0, ch: 0, outcome: false },
  };
  c.age = daysSince(c.reg);
  c.nextDate = c.lastTouch?.next_date || null;
  c.overdue = !!c.nextDate && c.nextDate < todayIso();
  c.isNew = (Date.now() - new Date(c.firstSeen).getTime()) < 24 * 3600 * 1000;
  c.it = c.sector === "IT та програмування";
  c.score = scoreOf(c);
  c.fit = levelOf(c.score.total);
  c.checks = creditChecks(c);
  c.missing = c.checks.filter((x) => !x[1]).map((x) => x[2]);
  c.search = [c.krs, d.name, d.nip, d.regon, d.city, d.voivodeship, d.ua_owner, d.dm, d.pkd_main, d.activity, d.products, d.it_needs, d.rationale, d.next_step, c.lastTouch?.summary, c.lastTouch?.next_step]
    .filter(Boolean).join(" ").toLowerCase();
  return c;
}

// The seven crediting conditions. The krs-api function stamps credited_at from the same list (creditMet); keep both in step.
function creditChecks(c) {
  const a = c.agg;
  const next = CLOSED.includes(c.status) || !!(c.lastTouch?.next_step && c.lastTouch?.next_date);
  return [
    ["ICP = Так", c.icp === "yes", "ICP"],
    ["Щонайменше 2 релевантні ЛПР", c.dmCount >= 2, `додати ЛПР (${c.dmCount}/2)`],
    ["Щонайменше 3 змістовні дотики", a.m >= 3, `ще ${Math.max(0, 3 - a.m)} дотик(и)`],
    ["Щонайменше 2 різні канали", a.ch >= 2, "додати канал"],
    ["Зафіксований результат дотику", a.outcome, "результат"],
    ["Наступна дія з датою або компанію закрито", next, "наступна дія і дата"],
    ["Є підтвердження / посилання", !!c.proof, "підтвердження"],
  ];
}

// Per company: meaningful touches, distinct channels among them, whether any has an outcome.
function touchAggregates(log) {
  const m = new Map();
  for (const t of log) {
    if (!t.m) continue;
    const a = m.get(t.krs) || { m: 0, chans: new Set(), outcome: false };
    a.m++; a.chans.add(t.ch); if (t.o) a.outcome = true;
    m.set(t.krs, a);
  }
  for (const a of m.values()) a.ch = a.chans.size;
  return m;
}

// ---------- filtering ----------
const FLAGS = {
  fresh7: { label: "Зареєстровані ≤7 днів", test: (c) => c.age != null && c.age <= 7 },
  fresh30: { label: "Зареєстровані ≤30 днів", test: (c) => c.age != null && c.age <= 30 },
  newin: { label: "Нові в базі (24 год)", test: (c) => c.isNew },
  site: { label: "Є підтверджений сайт", test: (c) => !!c.site },
  b2b: { label: "B2B", test: (c) => /b2b/i.test(c.d.b2b_b2c || "") },
  it: { label: "IT: партнер/конкурент", test: (c) => c.it },
  dm: { label: "Відомий ЛПР", test: (c) => known(c.d.dm) },
  untouched: { label: "Ще не опрацьовані", test: (c) => c.status === "new" },
  notouch: { label: "Без дотиків", test: (c) => !c.touchCount },
  overdue: { label: "Прострочений наступний крок", test: (c) => c.overdue },
  mine: { label: "Мої", test: (c) => c.owner && c.owner === (state.user.display_name || state.user.username) },
  inplan: { label: "У плані циклу", test: (c) => !!c.cycleMonth },
  credited: { label: "Зараховано", test: (c) => !!c.credited },
  blocker: { label: "Є блокер", test: (c) => !!c.blocker },
  // Data-quality checks, reached from the cycle page; shown only while active.
  noowner: { label: "Без відповідального", hidden: true, test: (c) => !c.owner },
  noicp: { label: "ICP не підтверджено", hidden: true, test: (c) => c.icp !== "yes" },
  lt2dm: { label: "Менше 2 ЛПР", hidden: true, test: (c) => c.dmCount < 2 },
  lt3: { label: "Менше 3 змістовних дотиків", hidden: true, test: (c) => c.agg.m < 3 },
  lt2ch: { label: "Менше 2 каналів", hidden: true, test: (c) => c.agg.ch < 2 },
  nonext: { label: "Немає наступної дії з датою", hidden: true, test: (c) => !c.checks[5][1] },
  noproof: { label: "Немає підтвердження", hidden: true, test: (c) => !c.proof },
};

function applyFilters(list, f, skip) {
  const q = f.q.trim().toLowerCase();
  return list.filter((c) => {
    if (!f.showRemoved && c.removed) return false;
    if (q && !q.split(/\s+/).every((t) => c.search.includes(t))) return false;
    if (skip !== "fit" && f.fit.length && !f.fit.includes(c.fit)) return false;
    if (skip !== "voiv" && f.voiv.length && !f.voiv.includes(c.voiv)) return false;
    if (skip !== "sector" && f.sector.length && !f.sector.includes(c.sector)) return false;
    if (skip !== "status" && f.status.length && !f.status.includes(c.status)) return false;
    if (skip !== "owner" && f.owner.length && !f.owner.includes(c.owner || "—")) return false;
    if (skip !== "prio" && f.prio.length && !f.prio.includes(c.priority || "—")) return false;
    if (skip !== "segment" && f.segment.length && !f.segment.includes(c.segment || "—")) return false;
    if (f.from && (!c.reg || c.reg < f.from)) return false;
    if (f.to && (!c.reg || c.reg > f.to)) return false;
    for (const fl of f.flags) if (FLAGS[fl] && !FLAGS[fl].test(c)) return false;
    return true;
  });
}

const SORTS = {
  score: (c) => c.score.total,
  reg: (c) => c.reg || "",
  name: (c) => c.name.toLowerCase(),
  city: (c) => c.city.toLowerCase(),
  fit: (c) => -FIT_ORDER.indexOf(c.fit),
  status: (c) => Object.keys(STATUS).indexOf(c.status),
  seen: (c) => c.firstSeen || "",
  touch: (c) => c.lastTouch?.touched_at || "",
};

function sorted(list) {
  const { key, dir } = state.sort;
  const fn = SORTS[key];
  return [...list].sort((a, b) => {
    const x = fn(a), y = fn(b);
    if (x < y) return -dir;
    if (x > y) return dir;
    return (b.reg || "").localeCompare(a.reg || "");
  });
}

function countBy(list, fn) {
  const m = new Map();
  for (const c of list) { const k = fn(c); m.set(k, (m.get(k) || 0) + 1); }
  return m;
}

// URL hash keeps filters shareable between colleagues.
function writeHash() {
  const f = state.filters;
  const p = new URLSearchParams();
  p.set("v", state.view);
  for (const k of ["fit", "voiv", "sector", "status", "owner", "prio", "segment", "flags"]) if (f[k].length) p.set(k, f[k].join("~"));
  for (const k of ["q", "from", "to"]) if (f[k]) p.set(k, f[k]);
  if (f.showRemoved) p.set("removed", "1");
  if (state.sort.key !== "score" || state.sort.dir !== -1) p.set("sort", `${state.sort.key}.${state.sort.dir}`);
  if (state.openKrs) p.set("krs", state.openKrs);
  history.replaceState(null, "", "#" + p.toString());
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const f = defaultFilters();
  for (const k of ["fit", "voiv", "sector", "status", "owner", "prio", "segment", "flags"]) if (p.get(k)) f[k] = p.get(k).split("~");
  for (const k of ["q", "from", "to"]) if (p.get(k)) f[k] = p.get(k);
  f.showRemoved = p.get("removed") === "1";
  state.filters = f;
  if (["overview", "companies", "cycle", "admin"].includes(p.get("v"))) state.view = p.get("v");
  if (p.get("sort")) { const [k, d] = p.get("sort").split("."); if (SORTS[k]) state.sort = { key: k, dir: Number(d) || -1 }; }
  state.openKrs = p.get("krs") || null;
}

const MARK = `<div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="M12 12l6-6"/></svg></div>`;

// ---------- auth screens ----------
function renderLogin(msg = "") {
  $("#app").innerHTML = `
  <div class="auth-wrap"><form class="auth-card" id="loginForm" autocomplete="on">
    ${MARK}
    <h1>KRS <span>Radar</span></h1>
    <p>Нові польські компанії з українськими власниками</p>
    <label class="field"><span>Логін</span><input class="input" name="username" autocomplete="username" required autofocus></label>
    <label class="field"><span>Пароль</span><input class="input" name="password" type="password" autocomplete="current-password" required></label>
    <div class="error" id="loginErr">${esc(msg)}</div>
    <button class="btn primary block" type="submit">Увійти</button>
  </form></div>`;
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const btn = e.target.querySelector("button");
    btn.disabled = true; btn.textContent = "Перевіряю…";
    try {
      const r = await api("login", { username: fd.get("username"), password: fd.get("password") });
      state.token = r.token; state.user = r.user; tokenSet(r.token);
      afterAuth();
    } catch (err) {
      $("#loginErr").textContent = err.message;
      btn.disabled = false; btn.textContent = "Увійти";
    }
  });
}

function passwordForm(forced) {
  return `
  <form class="auth-card" id="pwForm" autocomplete="off">
    ${MARK}
    <h1>${forced ? "Змініть пароль" : "Зміна пароля"}</h1>
    <p>${forced ? "Це перший вхід або пароль скинув адміністратор. Задайте власний пароль, щоб продовжити." : "Після зміни інші ваші сесії буде завершено."}</p>
    <label class="field"><span>Поточний пароль</span><input class="input" name="old" type="password" autocomplete="current-password" required></label>
    <label class="field"><span>Новий пароль</span><input class="input" name="n1" type="password" autocomplete="new-password" minlength="10" required></label>
    <div class="hint">Щонайменше 10 символів, літери й цифри.</div>
    <label class="field"><span>Повторіть новий пароль</span><input class="input" name="n2" type="password" autocomplete="new-password" required></label>
    <div class="error" id="pwErr"></div>
    <div style="display:flex;gap:8px">
      <button class="btn primary plain" type="submit" style="flex:1">Зберегти</button>
      ${forced ? `<button class="btn" type="button" id="pwLogout">Вийти</button>` : `<button class="btn" type="button" id="pwCancel">Скасувати</button>`}
    </div>
  </form>`;
}

function bindPasswordForm(forced, done) {
  $("#pwForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (fd.get("n1") !== fd.get("n2")) { $("#pwErr").textContent = "Паролі не збігаються"; return; }
    try {
      const r = await api("change_password", { old_password: fd.get("old"), new_password: fd.get("n1") });
      state.user = r.user;
      done();
    } catch (err) { $("#pwErr").textContent = err.message; }
  });
  if (forced) $("#pwLogout").addEventListener("click", logout);
  else $("#pwCancel").addEventListener("click", done);
}

function renderForcedChange() {
  $("#app").innerHTML = `<div class="auth-wrap">${passwordForm(true)}</div>`;
  bindPasswordForm(true, afterAuth);
}

function openPasswordModal() {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = passwordForm(false);
  document.body.appendChild(m);
  bindPasswordForm(false, () => m.remove());
}

async function logout() {
  try { await api("logout"); } catch { /* already gone */ }
  logoutLocal();
}

function logoutLocal() {
  state.token = null; state.user = null; tokenSet(null);
  clearInterval(state.timer);
  renderLogin();
}

async function afterAuth() {
  if (state.user.must_change) return renderForcedChange();
  readHash();
  if (state.view === "admin" && state.user.role !== "admin") state.view = "overview";
  renderShell();
  await loadData();
  clearInterval(state.timer);
  state.timer = setInterval(() => loadData(true), REFRESH_MS);
}

// ---------- data ----------
async function loadData(silent) {
  try {
    const r = await api("data");
    state.touchLog = r.touch_log || [];
    state.touchAgg = touchAggregates(state.touchLog);
    state.cycle = r.cycle;
    state.teamUsers = r.team_users || [];
    state.data = r.companies.map(enrich);
    state.team = r.team;
    state.lastSync = r.last_sync;
    state.loadedAt = new Date().toISOString();
    renderView();
    renderSync();
    if (state.openKrs && !silent) openDrawer(state.openKrs);
  } catch (err) {
    if (!silent && state.token) $("#view").innerHTML = `<div class="empty">Не вдалося завантажити дані: ${esc(err.message)}</div>`;
  }
}

// ---------- shell ----------
function renderShell() {
  const u = state.user;
  $("#app").innerHTML = `
  <div class="hero">
    <div class="top">
      <div class="brand">${MARK}KRS Radar</div>
      <nav class="tabs" id="tabs">
        <button class="tab" data-v="overview">Огляд</button>
        <button class="tab" data-v="companies">Компанії</button>
        <button class="tab" data-v="cycle">Цикл</button>
        ${u.role === "admin" ? `<button class="tab" data-v="admin">Адміністрування</button>` : ""}
      </nav>
      <div class="top-right">
        <span class="pill" id="sync"></span>
        <span class="pill"><b id="meName">${esc(u.display_name || u.username)}</b></span>
        <button class="btn" id="pwBtn">Пароль</button>
        <button class="btn blue" id="outBtn">Вийти</button>
      </div>
    </div>
    <div class="hero-title" id="heroTitle"></div>
  </div>
  <main id="view"><div class="empty">Завантаження…</div></main>`;
  $("#tabs").addEventListener("click", (e) => { const v = e.target.dataset.v; if (v) setView(v); });
  $("#pwBtn").addEventListener("click", openPasswordModal);
  $("#outBtn").addEventListener("click", logout);
  markTabs();
}

const HERO = {
  overview: ["Нові компанії", "з українськими власниками", "Реєстри KRS і CRBR щогодини: хто відкрився в Польщі, де, в якій галузі і наскільки підходить під наш профіль."],
  companies: ["Компанії", "фільтри, оцінка й робота команди", "Відкрийте картку, щоб побачити реєстрові дані, джерела й історію дотиків."],
  cycle: ["Цикл продажів", "цілі, план і якість даних", "Показники за тиждень, місяць і весь цикл рахуються з історії дотиків. Клік по рядку відкриває відфільтрований список компаній."],
  admin: ["Адміністрування", "акаунти й синхронізація", "Додавайте колег, скидайте паролі, стежте за імпортом бази."],
};

function markTabs() {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.v === state.view));
  const h = HERO[state.view];
  const el = $("#heroTitle");
  if (h && el) el.innerHTML = `<h1>${esc(h[0])} <span>${esc(h[1])}</span></h1><p>${esc(h[2])}</p>`;
}

function setView(v) {
  state.view = v;
  markTabs();
  writeHash();
  renderView();
  window.scrollTo(0, 0);
}

function renderSync() {
  const s = state.lastSync;
  const el = $("#sync");
  if (!el) return;
  const stale = !s || Date.now() - new Date(s.at).getTime() > 2 * 3600 * 1000;
  el.innerHTML = s
    ? `<span class="sync-dot ${stale ? "stale" : ""}"></span>Оновлено <b>${esc(fmtDT(s.at))}</b>`
    : `<span class="sync-dot stale"></span>Ще не синхронізовано`;
  el.title = s ? `Останній імпорт: ${s.total} рядків, нових ${s.inserted}, змінених ${s.updated}` : "";
}

function renderView() {
  if (!state.user) return;
  if (state.view === "overview") renderOverview();
  else if (state.view === "companies") renderCompanies();
  else if (state.view === "cycle") renderCycle();
  else if (state.view === "admin") renderAdmin();
}

// Jump from an overview tile to a filtered company list.
function drill(patch) {
  state.filters = { ...defaultFilters(), ...patch };
  setView("companies");
}

// ---------- overview ----------
function hbars(map, filterKey, limit = 12, order) {
  let rows = [...map.entries()];
  rows = order ? rows.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])) : rows.sort((a, b) => b[1] - a[1]);
  rows = rows.slice(0, limit);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  if (!rows.length) return `<div class="faint">Немає даних</div>`;
  return rows.map(([k, n]) => `
    <div class="hbar" data-drill="${esc(filterKey)}" data-val="${esc(k)}" title="${esc(k)}: ${n}">
      <span class="lbl">${esc(filterKey === "voiv" ? titleCase(k) : k)}</span>
      <span class="track"><span class="fill" style="width:${(n / max) * 100}%"></span></span>
      <span class="n">${n}</span>
    </div>`).join("");
}

function renderOverview() {
  const all = state.data.filter((c) => !c.removed);
  const by = (fn) => all.filter(fn).length;
  const week = by((c) => c.age != null && c.age <= 7);
  const month = by((c) => c.age != null && c.age <= 30);
  const newIn = by((c) => c.isNew);
  const hi = by((c) => c.fit === "Висока");
  const mid = by((c) => c.fit === "Середня");
  const site = by((c) => !!c.site);
  const untouched = by((c) => c.status === "new");
  const overdue = by((c) => c.overdue);
  const inWork = by((c) => ["research", "qualified", "contacted", "meeting"].includes(c.status));

  // Registrations by day, last 30 days.
  const days = [];
  for (let i = 29; i >= 0; i--) { const d = today(); d.setDate(d.getDate() - i); days.push(d.toISOString().slice(0, 10)); }
  const regCount = countBy(all, (c) => c.reg);
  const maxDay = Math.max(1, ...days.map((d) => regCount.get(d) || 0));
  const older = all.filter((c) => c.reg && c.reg < days[0]).length;

  const top = [...all].filter((c) => c.status !== "not_relevant" && !c.it).sort((a, b) => b.score.total - a.score.total).slice(0, 8);
  const recent = [...all].sort((a, b) => (b.firstSeen || "").localeCompare(a.firstSeen || "") || (b.reg || "").localeCompare(a.reg || "")).slice(0, 8);

  const statusMap = countBy(all, (c) => STATUS[c.status]);

  $("#view").innerHTML = `
  <div class="kpis">
    <button class="kpi" data-k="all"><div class="v">${all.length}</div><div class="l">Компаній у базі</div><div class="s">${state.data.length - all.length ? `${state.data.length - all.length} вилучено з джерела` : "активні записи"}</div></button>
    <button class="kpi" data-k="newin"><div class="v">${newIn}</div><div class="l">Нові за 24 год</div><div class="s">додані останньою синхронізацією</div></button>
    <button class="kpi" data-k="fresh7"><div class="v">${week}</div><div class="l">Реєстрація ≤7 днів</div><div class="s">${month} за 30 днів</div></button>
    <button class="kpi" data-k="hi"><div class="v">${hi}</div><div class="l">Висока відповідність</div><div class="s">ще ${mid} — середня</div></button>
    <button class="kpi" data-k="site"><div class="v">${site}</div><div class="l">З підтвердженим сайтом</div><div class="s">${Math.round((site / Math.max(1, all.length)) * 100)}% бази</div></button>
    <button class="kpi" data-k="untouched"><div class="v">${untouched}</div><div class="l">Не опрацьовано</div><div class="s">${inWork} у роботі</div></button>
    <button class="kpi ${overdue ? "accent" : ""}" data-k="overdue"><div class="v">${overdue}</div><div class="l">Прострочені кроки</div><div class="s">наступний дотик уже мав бути</div></button>
  </div>

  <div class="grid2">
    <div class="panel">
      <h3>Найперспективніші</h3>
      <div class="sub">За оцінкою відповідності: фізичний об'єкт, цільова галузь, вікно запуску, масштаб, контакт. IT-компанії винесено окремо</div>
      <div class="toplist">${top.map(rowMini).join("") || `<div class="faint">Немає даних</div>`}</div>
    </div>
    <div class="panel">
      <h3>Останні надходження</h3>
      <div class="sub">У порядку появи в базі</div>
      <div class="toplist">${recent.map(rowMini).join("") || `<div class="faint">Немає даних</div>`}</div>
    </div>
  </div>

  <div class="panel" style="margin-bottom:12px">
    <h3>Реєстрації за 30 днів</h3>
    <div class="sub">За датою реєстрації в KRS${older ? ` · ще ${older} компаній зареєстровані раніше` : ""}</div>
    <div class="cols">${days.map((d) => {
      const n = regCount.get(d) || 0;
      return `<div class="col" data-day="${d}" title="${fmtDate(d)}: ${n}">
        <span class="c">${n || ""}</span>
        <span class="b" style="height:${(n / maxDay) * 100}%"></span>
        <span class="t">${d.slice(8)}.${d.slice(5, 7)}</span></div>`;
    }).join("")}</div>
  </div>

  <div class="grid2">
    <div class="panel"><h3>Відповідність</h3><div class="sub">Висока ≥60 · Середня 40–59 · Низька &lt;40</div>${hbars(countBy(all, (c) => c.fit), "fit", 6, FIT_ORDER)}</div>
    <div class="panel"><h3>Галузі</h3><div class="sub">За головним PKD</div>${hbars(countBy(all, (c) => c.sector), "sector")}</div>
    <div class="panel"><h3>Воєводства</h3><div class="sub">Де зареєстровані</div>${hbars(countBy(all, (c) => c.voiv), "voiv", 16)}</div>
    <div class="panel"><h3>Робота команди</h3><div class="sub">Статуси опрацювання</div>${hbars(statusMap, "statusLabel", 8, Object.values(STATUS))}</div>
  </div>`;

  $("#view").querySelectorAll(".kpi").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.k;
    if (k === "all") drill({});
    else if (k === "hi") drill({ fit: ["Висока"] });
    else drill({ flags: [k] });
  }));
  $("#view").querySelectorAll("[data-drill]").forEach((el) => el.addEventListener("click", () => {
    const key = el.dataset.drill, val = el.dataset.val;
    if (key === "statusLabel") drill({ status: [Object.keys(STATUS).find((s) => STATUS[s] === val)] });
    else drill({ [key]: [val] });
  }));
  $("#view").querySelectorAll("[data-day]").forEach((el) => el.addEventListener("click", () => drill({ from: el.dataset.day, to: el.dataset.day })));
  bindRowOpen();
}

function scoreBadge(c) {
  const t = c.score.total;
  return `<span class="score ${t >= 60 ? "s3" : t >= 40 ? "s2" : "s1"}" title="${esc(c.score.parts.map(([l, p]) => `${l}: +${p}`).join("\n"))}">${t}</span>`;
}

function fitBadge(fit) { return `<span class="badge ${FIT_CLASS[fit] || ""}">${esc(fit)}</span>`; }

function rowMini(c) {
  return `<div class="row" data-open="${c.krs}">
    ${scoreBadge(c)}
    <div class="nm"><b>${esc(c.name)}</b><span>${esc(c.city)} · ${esc(c.sector)} · ${fmtDate(c.reg)}</span></div>
    ${c.isNew ? `<span class="badge new">нова</span>` : ""}${c.it ? ` <span class="badge" title="IT-компанія: імовірний партнер або конкурент, не клієнт">партнер/конкурент</span>` : ""}${fitBadge(c.fit)}
  </div>`;
}

function bindRowOpen() {
  $("#view").querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    openDrawer(el.dataset.open);
  }));
}

// ---------- companies ----------
// Owner counts plus every active team member, so people with no companies yet can be picked too.
function withTeam(map) {
  for (const t of state.team) if (!map.has(t)) map.set(t, 0);
  return map;
}

function facet(title, key, map, labelFn = (x) => x, order) {
  const f = state.filters[key];
  let rows = [...map.entries()];
  for (const sel of f) if (!map.has(sel)) rows.push([sel, 0]);
  rows = order ? rows.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])) : rows.sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  return `<h4>${esc(title)}</h4>` + rows.map(([k, n]) => `
    <label class="chk"><input type="checkbox" data-facet="${key}" value="${esc(k)}" ${f.includes(k) ? "checked" : ""}>
    <span>${esc(labelFn(k))}</span><span class="cnt">${n}</span></label>`).join("");
}

function renderCompanies() {
  const f = state.filters;
  const base = state.data;
  const list = sorted(applyFilters(base, f));
  const fc = (key, fn) => countBy(applyFilters(base, f, key), fn);
  const activeChips = [];
  for (const k of ["fit", "voiv", "sector", "owner", "segment"]) for (const v of f[k]) activeChips.push([k, v, k === "voiv" ? titleCase(v) : v === "—" ? "Без значення" : v]);
  for (const v of f.prio) activeChips.push(["prio", v, `Пріоритет: ${PRIORITY[v] || "—"}`]);
  for (const v of f.flags) if (FLAGS[v]?.hidden) activeChips.push(["flags", v, FLAGS[v].label]);
  for (const v of f.status) activeChips.push(["status", v, STATUS[v]]);
  if (f.from || f.to) activeChips.push(["date", "", `Реєстрація ${f.from ? "від " + fmtDate(f.from) : ""} ${f.to ? "до " + fmtDate(f.to) : ""}`]);

  const sortTh = (key, label, cls = "") => `<th data-sort="${key}" class="${cls} ${state.sort.key === key ? "sorted" + (state.sort.dir === 1 ? " asc" : "") : ""}">${label}</th>`;

  $("#view").innerHTML = `
  <div class="layout">
    <aside class="filters ${state.filtersOpen ? "open" : ""}" id="filters">
      <h4>Період реєстрації</h4>
      <div class="daterow">
        <input class="input" type="date" id="fFrom" value="${esc(f.from)}" aria-label="Від">
        <input class="input" type="date" id="fTo" value="${esc(f.to)}" aria-label="До">
      </div>
      ${facet("Відповідність", "fit", fc("fit", (c) => c.fit), (x) => x, FIT_ORDER)}
      ${facet("Статус опрацювання", "status", fc("status", (c) => c.status), (x) => STATUS[x] || x, Object.keys(STATUS))}
      ${facet("Відповідальний", "owner", withTeam(fc("owner", (c) => c.owner || "—")), (x) => (x === "—" ? "Не призначено" : x))}
      ${facet("Пріоритет", "prio", fc("prio", (c) => c.priority || "—"), (x) => PRIORITY[x] || "Не задано", [...Object.keys(PRIORITY), "—"])}
      ${facet("Сегмент", "segment", fc("segment", (c) => c.segment || "—"), (x) => (x === "—" ? "Не задано" : x))}
      ${facet("Галузь (PKD)", "sector", fc("sector", (c) => c.sector))}
      ${facet("Воєводство", "voiv", fc("voiv", (c) => c.voiv), titleCase)}
      <h4>Інше</h4>
      <label class="chk"><input type="checkbox" id="fRemoved" ${f.showRemoved ? "checked" : ""}><span>Показати вилучені з джерела</span></label>
      <div style="margin-top:14px"><button class="btn small block" id="fReset">Скинути всі фільтри</button></div>
    </aside>
    <section>
      <div class="toolbar">
        <button class="btn filter-toggle" id="fToggle">Фільтри</button>
        <input class="input" id="q" type="search" placeholder="Пошук: назва, KRS, NIP, власник, місто, діяльність, нотатки…" value="${esc(f.q)}">
        <select class="select" id="ownerSel" aria-label="Відповідальний">
          <option value="">Відповідальний: усі</option>
          <option value="—" ${f.owner.length === 1 && f.owner[0] === "—" ? "selected" : ""}>Не призначено</option>
          ${state.team.map((t) => `<option value="${esc(t)}" ${f.owner.length === 1 && f.owner[0] === t ? "selected" : ""}>${esc(t)}${t === (state.user.display_name || state.user.username) ? " (я)" : ""}</option>`).join("")}
          ${f.owner.length > 1 ? `<option selected disabled>Кілька: ${esc(f.owner.join(", "))}</option>` : ""}
        </select>
        <select class="select" id="sortSel" aria-label="Сортування">
          ${[["score", "За відповідністю"], ["reg", "За датою реєстрації"], ["seen", "За появою в базі"], ["touch", "За останнім дотиком"], ["name", "За назвою"]].map(([k, l]) => `<option value="${k}" ${state.sort.key === k ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <button class="btn" id="csv">Експорт CSV</button>
      </div>
      <div class="chips">
        ${Object.entries(FLAGS).filter(([, v]) => !v.hidden).map(([k, v]) => `<button class="chip ${f.flags.includes(k) ? "on" : ""}" data-flag="${k}">${esc(v.label)}</button>`).join("")}
      </div>
      ${activeChips.length ? `<div class="chips">${activeChips.map(([k, v, l]) => `<button class="chip on x" data-unset="${k}" data-val="${esc(v)}">${esc(l)}</button>`).join("")}</div>` : ""}
      <div class="result-info">Знайдено <b>${list.length}</b> з ${base.filter((c) => f.showRemoved || !c.removed).length}</div>
      <div class="tablewrap">
        ${list.length ? `<table>
          <thead><tr>
            ${sortTh("score", "Оцінка")}
            ${sortTh("name", "Компанія")}
            ${sortTh("reg", "Реєстрація")}
            <th class="hide-m">Діяльність</th>
            <th class="hide-m">Власник / ЛПР</th>
            ${sortTh("fit", "Рівень")}
            ${sortTh("status", "Статус")}
            ${sortTh("touch", "Останній дотик", "hide-m")}
          </tr></thead>
          <tbody>${list.map(rowFull).join("")}</tbody>
        </table>` : `<div class="empty">Нічого не знайдено. Спробуйте зняти частину фільтрів.</div>`}
      </div>
    </section>
  </div>`;

  const rerender = () => { writeHash(); renderCompanies(); };
  let qTimer;
  $("#q").addEventListener("input", (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { f.q = e.target.value; rerender(); const q = $("#q"); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }, 250);
  });
  $("#ownerSel").addEventListener("change", (e) => { f.owner = e.target.value ? [e.target.value] : []; rerender(); });
  $("#sortSel").addEventListener("change", (e) => { state.sort = { key: e.target.value, dir: e.target.value === "name" ? 1 : -1 }; rerender(); });
  $("#fFrom").addEventListener("change", (e) => { f.from = e.target.value; rerender(); });
  $("#fTo").addEventListener("change", (e) => { f.to = e.target.value; rerender(); });
  $("#fRemoved").addEventListener("change", (e) => { f.showRemoved = e.target.checked; rerender(); });
  $("#fReset").addEventListener("click", () => { state.filters = defaultFilters(); writeHash(); renderCompanies(); });
  $("#fToggle").addEventListener("click", () => { state.filtersOpen = !state.filtersOpen; $("#filters").classList.toggle("open", state.filtersOpen); });
  $("#csv").addEventListener("click", () => exportCsv(list));
  $("#view").querySelectorAll("[data-facet]").forEach((el) => el.addEventListener("change", () => {
    const arr = f[el.dataset.facet];
    if (el.checked) arr.push(el.value); else arr.splice(arr.indexOf(el.value), 1);
    rerender();
  }));
  $("#view").querySelectorAll("[data-flag]").forEach((el) => el.addEventListener("click", () => {
    const k = el.dataset.flag;
    f.flags = f.flags.includes(k) ? f.flags.filter((x) => x !== k) : [...f.flags, k];
    rerender();
  }));
  $("#view").querySelectorAll("[data-unset]").forEach((el) => el.addEventListener("click", () => {
    const k = el.dataset.unset;
    if (k === "date") { f.from = ""; f.to = ""; } else f[k] = f[k].filter((x) => x !== el.dataset.val);
    rerender();
  }));
  $("#view").querySelectorAll("th[data-sort]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.sort;
    state.sort = state.sort.key === k ? { key: k, dir: -state.sort.dir } : { key: k, dir: k === "name" ? 1 : -1 };
    rerender();
  }));
  bindRowOpen();
}

function rowFull(c) {
  const owners = c.owners.length ? c.owners.map((o) => `${o.name}${o.pct != null ? ` ${o.pct}%` : ""}`).join(", ") : c.d.ua_owner;
  return `<tr data-open="${c.krs}">
    <td>${scoreBadge(c)}</td>
    <td><div class="nm">${c.priority ? `<span class="badge prio">${esc(c.priority === "partner" ? "Партнер" : c.priority)}</span> ` : ""}${esc(c.name)} ${c.isNew ? `<span class="badge new">нова</span>` : ""}${c.it ? ` <span class="badge" title="IT-компанія: імовірний партнер або конкурент, не клієнт">партнер/конкурент</span>` : ""} ${c.removed ? `<span class="badge removed">вилучено</span>` : ""}</div>
      <div class="sub">${esc(c.city)}${c.voiv !== "Невідомо" ? `, ${esc(titleCase(c.voiv))}` : ""} · KRS ${esc(c.krs)}${c.site ? ` · <a href="${esc(c.site)}" target="_blank" rel="noopener noreferrer" data-stop>сайт</a>` : ""}</div></td>
    <td class="num">${fmtDate(c.reg)}<div class="sub">${c.age != null ? `${c.age} дн. тому` : ""}</div></td>
    <td class="wrap hide-m"><div class="clip">${esc(c.sector)}${c.pkd ? ` · ${esc(c.pkd)}` : ""}</div><div class="sub clip">${shown(c.d.products || c.d.activity)}</div></td>
    <td class="wrap hide-m"><div class="clip">${esc(owners || "—")}</div>${known(c.d.dm) ? `<div class="sub clip">ЛПР: ${esc(c.d.dm)}</div>` : ""}</td>
    <td>${fitBadge(c.fit)}</td>
    <td><span class="badge">${esc(STATUS[c.status])}</span>${c.credited ? ` <span class="badge hi" title="Зараховано ${esc(fmtDate(c.credited))}">зараховано</span>` : ""}${c.owner ? `<div class="sub">${esc(c.owner)}</div>` : ""}${c.blocker ? `<div class="sub over-t">блокер</div>` : ""}</td>
    <td class="hide-m">${c.lastTouch
      ? `<div class="num">${esc(fmtDate(c.lastTouch.touched_at))} · ${esc(CHANNELS[c.lastTouch.channel] || "")}</div><div class="sub">${c.touchCount} ${plural(c.touchCount, "запис", "записи", "записів")}</div>${c.nextDate ? `<span class="badge ${c.overdue ? "over" : "new"}">далі ${esc(fmtDate(c.nextDate))}</span>` : ""}`
      : `<span class="faint">—</span>`}</td>
  </tr>`;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function exportCsv(list) {
  const cols = [
    ["KRS", (c) => c.krs], ["Назва", (c) => c.d.name], ["Дата реєстрації", (c) => c.reg], ["Місто", (c) => c.city], ["Воєводство", (c) => c.voiv],
    ["NIP", (c) => c.d.nip], ["REGON", (c) => c.d.regon], ["Капітал PLN", (c) => c.d.capital], ["Український власник", (c) => c.d.ua_owner],
    ["ЛПР", (c) => c.d.dm], ["Роль ЛПР", (c) => c.d.dm_role], ["PKD", (c) => c.d.pkd_main], ["Галузь", (c) => c.sector], ["Сайт", (c) => c.site],
    ["B2B/B2C", (c) => c.d.b2b_b2c], ["Відповідність", (c) => c.score.total], ["Рівень", (c) => c.fit], ["Оцінка дослідника (Excel)", (c) => c.d.src_fit], ["Обґрунтування", (c) => c.d.rationale],
    ["Можливі IT-потреби", (c) => c.d.it_needs], ["Наступний крок", (c) => c.d.next_step], ["Статус", (c) => STATUS[c.status]],
    ["Відповідальний", (c) => c.owner], ["Пріоритет", (c) => PRIORITY[c.priority]], ["Сегмент", (c) => c.segment], ["ICP", (c) => ICP[c.icp]],
    ["Місяць циклу", (c) => c.cycleMonth], ["Релевантних ЛПР", (c) => c.dmCount], ["Змістовних дотиків", (c) => c.agg.m], ["Каналів", (c) => c.agg.ch],
    ["Зараховано", (c) => c.credited], ["Чого не вистачає", (c) => c.missing.join("; ")], ["Блокер", (c) => c.blocker], ["Підтвердження", (c) => c.proof],
    ["Дотиків", (c) => c.touchCount],
    ["Останній дотик", (c) => c.lastTouch && `${c.lastTouch.touched_at.slice(0, 10)} ${CHANNELS[c.lastTouch.channel] || ""}: ${c.lastTouch.summary}`],
    ["Наступний крок команди", (c) => c.lastTouch?.next_step], ["Дата наступного кроку", (c) => c.nextDate], ["Джерела", (c) => c.d.sources],
  ];
  const cell = (v) => { const s = String(v ?? ""); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = "﻿" + [cols.map(([h]) => h).join(";"), ...list.map((c) => cols.map(([, fn]) => cell(fn(c))).join(";"))].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `krs-radar-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- drawer ----------
function links(c) {
  const d = c.d;
  const nameQ = encodeURIComponent(shortName(d.name));
  const krsInt = String(Number(c.krs));
  const out = [
    [`https://api-krs.ms.gov.pl/api/krs/OdpisAktualny/${c.krs}?rejestr=P&format=json`, "Odpis KRS (API)"],
    ["https://wyszukiwarka-krs.ms.gov.pl/", "Wyszukiwarka KRS"],
    [`https://rejestr.io/krs/${krsInt}`, "rejestr.io"],
    ["https://crbr.podatki.gov.pl/adcrbr/#/wyszukaj", "CRBR (бенефіціари)"],
  ];
  if (known(d.nip)) {
    out.push([`https://wl-api.mf.gov.pl/api/search/nip/${encodeURIComponent(d.nip)}?date=${new Date().toISOString().slice(0, 10)}`, "Biała lista VAT"]);
    out.push([`https://aleo.com/pl/firmy?phrase=${encodeURIComponent(d.nip)}`, "aleo.com"]);
  }
  if (c.site) out.push([c.site, "Сайт компанії"]);
  out.push([`https://www.google.com/search?q=${nameQ}+${encodeURIComponent(c.city)}`, "Google"]);
  out.push([`https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(shortName(d.name).replace(/ Sp\. z o\.o\./, ""))}`, "LinkedIn: компанія"]);
  for (const o of c.owners.slice(0, 3)) out.push([`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(o.name)}`, `LinkedIn: ${o.name}`]);
  out.push([`https://www.google.com/maps/search/${nameQ}+${encodeURIComponent(c.city)}`, "Карта"]);
  return out;
}

function sourceLinks(s) {
  if (!known(s)) return shown(s);
  return String(s).split(/\s*\|\s*/).filter(Boolean).map((x) => {
    const m = x.match(/https?:\/\/\S+/);
    return m ? `<a href="${esc(m[0])}" target="_blank" rel="noopener noreferrer">${esc(new URL(m[0]).hostname)}</a>${esc(x.replace(m[0], ""))}` : esc(x);
  }).join("<br>");
}

function kv(rows) {
  return `<dl class="kv">${rows.filter(([, v]) => v !== undefined).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
}

function openDrawer(krs) {
  const c = state.data.find((x) => x.krs === krs);
  if (!c) return;
  state.openKrs = krs;
  writeHash();
  closeDrawer(true);
  const d = c.d;
  const w = c.work || {};
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  const dr = document.createElement("aside");
  dr.className = "drawer";
  dr.setAttribute("role", "dialog");
  dr.innerHTML = `
  <header>
    ${scoreBadge(c)}
    <div style="flex:1;min-width:0">
      <h2>${esc(c.name)}</h2>
      <div class="meta">${fitBadge(c.fit)} ${c.isNew ? `<span class="badge new">нова</span>` : ""}${c.it ? ` <span class="badge" title="IT-компанія: імовірний партнер або конкурент, не клієнт">партнер/конкурент</span>` : ""} ${c.removed ? `<span class="badge removed">вилучено з джерела</span>` : ""}
        <span>KRS ${esc(c.krs)}</span><span>· ${esc(c.city)}</span><span>· зареєстр. ${fmtDate(c.reg)}${c.age != null ? ` (${c.age} дн.)` : ""}</span></div>
    </div>
    <button class="btn small" id="drClose" aria-label="Закрити">✕</button>
  </header>
  <div class="body">
    <div class="sec">
      <h4>Робота команди <small id="wMsg">${w.updated_by ? `оновив ${esc(w.updated_by)} ${esc(fmtDT(w.updated_at))}` : ""}</small></h4>
      <div class="work-row">
        <label class="mini"><span>Статус</span><select class="select" data-w="status">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${c.status === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="mini"><span>Відповідальний</span><select class="select" data-w="owner"><option value="">—</option>${state.team.map((t) => `<option ${w.owner === t ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
        <label class="mini"><span>Пріоритет</span><select class="select" data-w="priority"><option value="">—</option>${Object.entries(PRIORITY).map(([k, l]) => `<option value="${k}" ${c.priority === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
        <label class="mini"><span>Сегмент</span><select class="select" data-w="segment"><option value="">—</option>${[...new Set([...SEGMENTS, ...(c.segment ? [c.segment] : [])])].map((x) => `<option ${c.segment === x ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></label>
        <label class="mini"><span>ICP</span><select class="select" data-w="icp"><option value="">—</option>${Object.entries(ICP).map(([k, l]) => `<option value="${k}" ${c.icp === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="mini"><span>Місяць циклу</span><select class="select" data-w="cycle_month"><option value="">Не в плані</option>${[1, 2, 3].map((m) => `<option value="${m}" ${c.cycleMonth === m ? "selected" : ""}>Місяць ${m}</option>`).join("")}</select></label>
      </div>
      <label class="mini wide"><span>Підтвердження / посилання (CRM, листування, LinkedIn)</span><input class="input" data-w="proof" value="${esc(c.proof)}" placeholder="https://…"></label>
      <label class="mini wide"><span>Блокер / потрібна допомога</span><textarea class="input" data-w="blocker" rows="2" placeholder="Що заважає рухатися далі">${esc(c.blocker)}</textarea></label>
    </div>

    <div class="sec">
      <h4>Зарахування <small>${c.credited ? `<span class="ok">зараховано ${esc(fmtDate(c.credited))}</span>` : `${c.checks.filter((x) => x[1]).length} з ${c.checks.length} умов`}</small></h4>
      <ul class="checklist">${c.checks.map(([l, ok]) => `<li class="${ok ? "ok" : ""}">${esc(l)}</li>`).join("")}</ul>
      ${c.credited ? "" : `<div class="faint" style="margin-top:8px">Чого не вистачає: ${esc(c.missing.join("; "))}</div>`}
    </div>

    <div class="sec">
      <h4>Контакти (ЛПР) <small id="cCount"></small></h4>
      <div id="cList" class="contacts"><div class="faint">Завантаження…</div></div>
      <details class="cform-wrap" id="cWrap">
        <summary class="btn small">Додати контакт</summary>
        <form class="touch-form" id="cForm" autocomplete="off" style="margin-top:10px">
          <input type="hidden" name="id">
          <div class="row2">
            <input class="input" name="full_name" required placeholder="Ім'я та прізвище">
            <input class="input" name="position" placeholder="Посада (CEO, prezes zarządu…)">
          </div>
          <div class="row3">
            <input class="input" name="email" type="email" placeholder="Email">
            <input class="input" name="phone" placeholder="Телефон">
            <select class="select" name="language" aria-label="Мова"><option value="">Мова: —</option>${LANGS.map((l) => `<option>${l}</option>`).join("")}</select>
          </div>
          <input class="input" name="linkedin" placeholder="LinkedIn: https://www.linkedin.com/in/…">
          <div class="row2">
            <input class="input" name="source" placeholder="Джерело (KRS / CRBR, Sales Nav…)">
            <select class="select" name="invite" aria-label="Запрошення в LinkedIn"><option value="">Запрошення: —</option>${Object.entries(INVITE).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
          </div>
          <textarea class="input" name="note" rows="2" placeholder="Нотатки"></textarea>
          <div class="actions">
            <label class="chk"><input type="checkbox" name="relevant" checked><span>Релевантний ЛПР</span></label>
            <button class="btn primary" type="submit">Зберегти контакт</button>
            <button class="btn small" type="button" id="cCancel">Скасувати</button>
            <span class="faint" id="cMsg"></span>
          </div>
        </form>
      </details>
    </div>

    <div class="sec">
      <h4>Історія дотиків <small id="tCount"></small></h4>
      <form class="touch-form" id="tForm" autocomplete="off">
        <div class="row3">
          <input class="input" type="datetime-local" name="touched_at" value="${localNow()}" aria-label="Коли">
          <select class="select" name="channel" aria-label="Канал">${Object.entries(CHANNELS).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
          <select class="select" name="direction" aria-label="Напрям"><option value="out">Ми → клієнт</option><option value="in">Клієнт → ми</option><option value="">—</option></select>
        </div>
        <div class="row2">
          <select class="select" name="contact_id" id="tContact" aria-label="З ким"><option value="">З ким: —</option></select>
          <select class="select" name="outcome" aria-label="Результат"><option value="">Результат: —</option>${Object.entries(OUTCOMES).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
        </div>
        <textarea class="input" name="summary" rows="3" required placeholder="Що було: про що говорили, що з'ясували, що надіслали…"></textarea>
        <div class="row-next">
          <input class="input" name="next_step" placeholder="Наступний крок (напр. надіслати пропозицію)">
          <input class="input" type="date" name="next_date" aria-label="Дата наступного кроку">
        </div>
        <div class="flagrow">
          <label class="chk"><input type="checkbox" name="meaningful" checked><span>Змістовний</span></label>
          ${Object.entries(TOUCH_FLAGS).map(([k, l]) => `<label class="chk"><input type="checkbox" name="${k}"><span>${l}</span></label>`).join("")}
        </div>
        <div class="actions">
          <button class="btn primary" type="submit">Додати дотик</button>
          <span class="faint" id="tMsg">Теплий — предметний інтерес, погоджений дзвінок чи запит інформації; прийняте запрошення чи «дякую» не рахуються. Discovery і кваліфікацію позначайте після фактичної події.</span>
        </div>
      </form>
      <div class="timeline" id="tList"><div class="faint">Завантаження…</div></div>
    </div>

    <div class="sec">
      <h4>Чому це цікаво</h4>
      ${known(d.rationale) ? `<div class="callout">${esc(d.rationale)}</div>` : `<div class="faint">Обґрунтування ще немає</div>`}
      <div style="margin-top:10px">${kv([
        ["Оцінка дослідника (Excel)", shown(d.src_fit)],
        ["Можливі IT-потреби", shown(d.it_needs)],
        ["Наступний крок", shown(d.next_step)],
        ["З чого склалась оцінка", `<div class="breakdown">${c.score.parts.map(([l, p]) => `<span>${esc(l)} <b>+${p}</b></span>`).join("")}</div>`],
      ])}</div>
    </div>

    <div class="sec"><h4>Швидкі перевірки</h4><div class="links">${links(c).map(([u, l]) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(l)}</a>`).join("")}</div></div>

    <div class="sec"><h4>Реєстр</h4>${kv([
      ["Повна назва", esc(d.name)],
      ["Форма", shown(d.legal_form)],
      ["Стан KRS", shown(d.krs_state)],
      ["Дата реєстрації", fmtDate(c.reg)],
      ["Місто / воєводство", `${esc(c.city)}${c.voiv !== "Невідомо" ? `, ${esc(titleCase(c.voiv))}` : ""}`],
      ["NIP", shown(d.nip)],
      ["REGON", shown(d.regon)],
      ["Капітал", c.capital ? `${c.capital.toLocaleString("uk-UA")} PLN` : shown(d.capital)],
    ])}</div>

    <div class="sec"><h4>Власники та ЛПР</h4>${kv([
      ["Український власник", shown(d.ua_owner)],
      ["Громадянство", d.citizenship ? `${esc(d.citizenship)}${d.citizenship_source ? ` <span class="faint">(${esc(d.citizenship_source)})</span>` : ""}` : shown(null)],
      ["Тип володіння", shown(d.ownership_type)],
      ["Частка", shown(d.share)],
      ["ЛПР", shown(d.dm)],
      ["Роль ЛПР", shown(d.dm_role)],
      ["Засновники та досвід", shown(d.founders)],
    ])}</div>

    <div class="sec"><h4>Діяльність</h4>${kv([
      ["Галузь", `${esc(c.sector)}${c.pkd ? ` · PKD ${esc(c.pkd)}` : ""}`],
      ["Головний PKD", shown(d.pkd_main)],
      ["Заявлена діяльність", shown(d.activity)],
      ["Фактичні продукти/послуги", shown(d.products)],
      ["B2B / B2C", shown(d.b2b_b2c)],
      ["Географія", shown(d.geography)],
    ])}</div>

    <div class="sec"><h4>Сайт і сигнали</h4>${kv([
      ["Сайт", c.site ? `<a href="${esc(c.site)}" target="_blank" rel="noopener noreferrer">${esc(c.site)}</a>` : shown(d.website)],
      ["Доказ відповідності", shown(d.website_evidence)],
      ["Сигнали та масштаб", shown(d.signals)],
      ["Новини й вакансії", shown(d.news)],
    ])}</div>

    <div class="sec"><h4>Джерела та службове</h4>${kv([
      ["Джерела", sourceLinks(d.sources)],
      ["Перевірено", fmtDate(d.checked_at)],
      ["Telegram", d.tg_date ? `${fmtDate(d.tg_date)}${d.tg_msg_id ? ` · повідомлення #${esc(d.tg_msg_id)}` : ""}` : shown(null)],
      ["Нотатки в Excel", shown(d.notes)],
      ["У базі дашборда з", esc(fmtDT(c.firstSeen))],
      ["Останні зміни з джерела", esc(fmtDT(c.updatedAt))],
      ...(d.extra ? Object.entries(d.extra).map(([k, v]) => [k, esc(v)]) : []),
    ])}</div>
  </div>`;
  document.body.append(scrim, dr);
  const close = () => closeDrawer();
  scrim.addEventListener("click", close);
  $("#drClose", dr).addEventListener("click", close);
  document.addEventListener("keydown", escClose);
  const saveWork = async (patch) => {
    try {
      await api("set_work", { krs, ...patch });
      await refreshDrawer(krs, `<span class="ok">збережено</span>`);
    } catch (err) { $("#wMsg", dr).textContent = err.message; }
  };
  dr.querySelectorAll("[data-w]").forEach((el) => el.addEventListener("change", () => {
    const k = el.dataset.w;
    if (k === "cycle_month" && el.value && !c.owner) $("#wMsg", dr).textContent = "Не забудьте призначити відповідального";
    saveWork({ [k]: el.value });
  }));
  const chan = $("#tForm", dr).channel, meaningfulBox = $("#tForm", dr).meaningful;
  chan.addEventListener("change", () => { meaningfulBox.checked = chan.value !== "note"; meaningfulBox.disabled = chan.value === "note"; });

  $("#tForm", dr).addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = Object.fromEntries(new FormData(form));
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const touchedAt = fd.touched_at ? new Date(fd.touched_at).toISOString() : undefined;
      const flags = Object.fromEntries(["meaningful", ...Object.keys(TOUCH_FLAGS)].map((k) => [k, !!form[k].checked]));
      await api("add_touch", { krs, ...fd, ...flags, touched_at: touchedAt });
      if (fd.channel !== "note" && (c.status === "new" || c.status === "research")) await api("set_work", { krs, status: "contacted" });
      await refreshDrawer(krs, "", `<span class="ok">Дотик додано</span>`);
    } catch (err) { $("#tMsg", dr).textContent = err.message; btn.disabled = false; }
  });

  const cForm = $("#cForm", dr);
  const resetContactForm = () => { cForm.reset(); cForm.id.value = ""; $("#cWrap", dr).open = false; };
  $("#cCancel", dr).addEventListener("click", resetContactForm);
  cForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(cForm));
    try {
      await api("save_contact", { krs, ...fd, id: fd.id ? Number(fd.id) : undefined, relevant: cForm.relevant.checked });
      await refreshDrawer(krs);
    } catch (err) { $("#cMsg", dr).textContent = err.message; }
  });
  loadContacts(c, dr);
  loadTouches(c, dr);
}

// Reloads everything (crediting, aggregates, the list behind the drawer) and rebuilds the drawer in place.
async function refreshDrawer(krs, workMsg = "", touchMsg = "") {
  const old = document.querySelector(".drawer");
  const top = old ? old.scrollTop : 0;
  await loadData(true);
  openDrawer(krs);
  const dr = document.querySelector(".drawer");
  if (!dr) return;
  dr.scrollTop = top;
  if (workMsg) $("#wMsg", dr).innerHTML = workMsg;
  if (touchMsg) $("#tMsg", dr).innerHTML = touchMsg;
}

async function loadContacts(c, dr) {
  const list = $("#cList", dr);
  try {
    const { contacts } = await api("contacts", { krs: c.krs });
    const me = state.user;
    $("#cCount", dr).textContent = contacts.length ? `${contacts.filter((x) => x.relevant).length} релевантних з ${contacts.length}` : "";
    $("#tContact", dr).innerHTML = `<option value="">З ким: —</option>` + contacts.map((x) => `<option value="${x.id}">${esc(x.full_name)}${x.position ? ` · ${esc(x.position)}` : ""}</option>`).join("");
    if (!contacts.length) {
      const hints = [...new Set([...c.owners.map((o) => o.name), ...(known(c.d.dm) ? String(c.d.dm).split(/;\s*/) : [])])];
      list.innerHTML = `<div class="faint">Контактів ще немає.${hints.length ? ` З реєстру: ${esc(hints.join(", "))}.` : ""}</div>`;
      return;
    }
    list.innerHTML = contacts.map((x) => `
      <div class="contact">
        <div class="h"><b>${esc(x.full_name)}</b>${x.position ? `<span>${esc(x.position)}</span>` : ""}
          ${x.relevant ? `<span class="badge hi">ЛПР</span>` : `<span class="badge">не ЛПР</span>`}
          ${x.language ? `<span class="badge">${esc(x.language)}</span>` : ""}
          ${x.invite ? `<span class="badge ${x.invite === "accepted" ? "new" : ""}">${esc(INVITE[x.invite])}</span>` : ""}</div>
        <div class="cl">
          ${x.linkedin ? `<a href="${esc(x.linkedin)}" target="_blank" rel="noopener noreferrer">LinkedIn</a>` : ""}
          ${x.email ? `<a href="mailto:${esc(x.email)}">${esc(x.email)}</a>` : ""}
          ${x.phone ? `<a href="tel:${esc(x.phone.replace(/[^\d+]/g, ""))}">${esc(x.phone)}</a>` : ""}
          ${x.source ? `<span class="faint">джерело: ${esc(x.source)}</span>` : ""}
        </div>
        ${x.note ? `<div class="txt">${esc(x.note)}</div>` : ""}
        <div class="h"><span>додав ${esc(x.created_by || "")}</span>
          <button class="del" data-cedit="${x.id}">редагувати</button>
          ${x.created_by_id === me.id || me.role === "admin" ? `<button class="del" data-cdel="${x.id}">видалити</button>` : ""}</div>
      </div>`).join("");
    list.querySelectorAll("[data-cedit]").forEach((b) => b.addEventListener("click", () => {
      const x = contacts.find((k) => k.id === Number(b.dataset.cedit));
      const f = $("#cForm", dr);
      for (const k of ["id", "full_name", "position", "email", "phone", "language", "linkedin", "source", "invite", "note"]) f[k].value = x[k] ?? "";
      f.relevant.checked = x.relevant;
      $("#cWrap", dr).open = true;
      f.full_name.focus();
    }));
    list.querySelectorAll("[data-cdel]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Видалити контакт? Дотики з ним залишаться в історії.")) return;
      try { await api("delete_contact", { id: Number(b.dataset.cdel) }); await refreshDrawer(c.krs); } catch (err) { alert(err.message); }
    }));
  } catch (err) {
    list.innerHTML = `<div class="error">${esc(err.message)}</div>`;
  }
}

function localNow() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

async function loadTouches(c, dr) {
  const list = $("#tList", dr);
  try {
    const { touches } = await api("touches", { krs: c.krs });
    // Entries logged within the same minute: newest insert first.
    touches.sort((x, y) => y.touched_at.localeCompare(x.touched_at) || y.id - x.id);
    $("#tCount", dr).textContent = touches.length ? `${touches.length} ${plural(touches.length, "запис", "записи", "записів")}` : "";
    if (!touches.length) { list.innerHTML = `<div class="faint">Ще не було жодного дотику.</div>`; return; }
    const me = state.user;
    list.innerHTML = touches.map((t, i) => `
      <div class="titem ${t.channel === "note" ? "note" : ""}">
        <div class="h">
          <b>${esc(CHANNELS[t.channel] || t.channel)}</b>
          ${t.direction ? `<span>${t.direction === "in" ? "клієнт → ми" : "ми → клієнт"}</span>` : ""}
          <span>· ${esc(fmtDT(t.touched_at))}</span>
          ${t.contact ? `<span>· ${esc(t.contact)}</span>` : ""}
          ${t.outcome ? `<span class="badge ${t.outcome === "not_interested" ? "lo" : t.outcome === "no_answer" ? "" : "new"}">${esc(OUTCOMES[t.outcome] || t.outcome)}</span>` : ""}
          ${t.channel !== "note" && !t.meaningful ? `<span class="badge">не змістовний</span>` : ""}
          ${Object.entries(TOUCH_FLAGS).filter(([k]) => t[k]).map(([, l]) => `<span class="badge hi">${l}</span>`).join("")}
          ${t.author_id === me.id || me.role === "admin" ? `<button class="del" data-del="${t.id}" title="Видалити запис">видалити</button>` : ""}
        </div>
        <div class="txt">${esc(t.summary)}</div>
        ${t.next_step || t.next_date ? `<div class="next ${i === 0 && t.next_date && t.next_date < todayIso() ? "over" : ""}">Далі: ${esc(t.next_step || "")}${t.next_date ? ` · до ${esc(fmtDate(t.next_date))}` : ""}</div>` : ""}
        <div class="h" style="margin-top:4px"><span>записав ${esc(t.author)}</span></div>
      </div>`).join("");
    list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Видалити цей запис з історії?")) return;
      try { await api("delete_touch", { id: Number(b.dataset.del) }); await refreshDrawer(c.krs); } catch (err) { alert(err.message); }
    }));
  } catch (err) {
    list.innerHTML = `<div class="error">${esc(err.message)}</div>`;
  }
}

function escClose(e) { if (e.key === "Escape") closeDrawer(); }

function closeDrawer(keepState) {
  document.querySelectorAll(".drawer, .scrim").forEach((el) => el.remove());
  document.removeEventListener("keydown", escClose);
  if (!keepState) { state.openKrs = null; writeHash(); }
}

// ---------- cycle ----------
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const localDay = (ts) => (ts ? isoOf(new Date(ts)) : null);
const shiftDay = (day, n) => { const d = new Date(day + "T12:00:00"); d.setDate(d.getDate() + n); return isoOf(d); };

const METRICS = [
  ["companies", "Компанії зі змістовними дотиками"],
  ["touches", "Змістовні дотики"],
  ["warm", "Теплі компанії"],
  ["discovery", "Discovery"],
  ["qualified", "Кваліфіковані потреби"],
  ["credited", "Зараховано"],
];

function cyclePeriods() {
  const t = todayIso();
  const ws = shiftDay(t, -((new Date(t + "T12:00:00").getDay() + 6) % 7));
  const d = new Date(t + "T12:00:00");
  const cy = state.cycle || {};
  return [
    ["Поточний тиждень", ws, shiftDay(ws, 6)],
    ["Попередній тиждень", shiftDay(ws, -7), shiftDay(ws, -1)],
    ["Поточний місяць", t.slice(0, 8) + "01", isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0))],
    ["Весь цикл", cy.start, cy.end],
  ];
}

// Companies count once per period however many touches they got; touches count each.
function cycleMetrics(a, b, who) {
  const inP = (day) => !!day && !!a && !!b && day >= a && day <= b;
  const ts = state.touchLog.filter((t) => t.m && inP(localDay(t.at)) && (!who || t.auid === who.id));
  const uniq = (fn) => new Set(ts.filter(fn).map((t) => t.krs)).size;
  return {
    companies: uniq(() => true), touches: ts.length, warm: uniq((t) => t.w), discovery: uniq((t) => t.d), qualified: uniq((t) => t.q),
    credited: state.data.filter((c) => inP(c.credited) && (!who || c.owner === who.name)).length,
    channels: countBy(ts, (t) => t.ch),
  };
}

const QUALITY = [
  ["noowner", "Без відповідального", "Призначити відповідального"],
  ["notouch", "Без дотиків", "Почати комунікацію"],
  ["noicp", "ICP не підтверджено", "Підтвердити ICP"],
  ["lt2dm", "Менше 2 ЛПР", "Додати decision makers"],
  ["lt3", "Менше 3 змістовних дотиків", "Продовжити комунікацію"],
  ["lt2ch", "Менше 2 каналів", "Додати другий канал"],
  ["nonext", "Немає наступної дії з датою", "Поставити конкретний follow-up"],
  ["overdue", "Прострочена наступна дія", "Виконати або перенести"],
  ["noproof", "Немає підтвердження", "Додати CRM / листування / LinkedIn"],
  ["blocker", "Є блокер", "Потрібна допомога керівника"],
];

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

function renderCycle() {
  const cy = state.cycle || { targets: {}, plan: {} };
  const targets = cy.targets || {};
  const periods = cyclePeriods();
  const vals = periods.map(([, a, b]) => cycleMetrics(a, b));
  const whole = vals[3];
  const t = todayIso();
  const totalDays = cy.start && cy.end ? Math.round((new Date(cy.end) - new Date(cy.start)) / 86400000) + 1 : 0;
  const passed = totalDays ? Math.min(totalDays, Math.max(0, Math.round((new Date(t) - new Date(cy.start)) / 86400000) + 1)) : 0;
  const pace = pct(passed, totalDays);
  const inPlan = state.data.filter((c) => !c.removed && c.cycleMonth);
  const soon = inPlan.filter((c) => c.nextDate && c.nextDate >= t && c.nextDate <= shiftDay(t, 7)).length;
  const isAdmin = state.user.role === "admin";

  const teamRows = state.teamUsers.map((u) => {
    const m = cycleMetrics(cy.start, cy.end, u);
    return { name: u.name, plan: cy.plan?.[u.id] ?? 0, inPlan: inPlan.filter((c) => c.owner === u.name).length, ...m };
  });
  const sum = (k) => teamRows.reduce((a, r) => a + r[k], 0);

  const chTotal = [...whole.channels.values()].reduce((a, n) => a + n, 0);
  const chRows = [...whole.channels.entries()].sort((a, b) => b[1] - a[1]);
  // Each step converts from the one before it, except crediting, which is measured against all touched companies.
  const funnel = [["Компанії з дотиками", whole.companies], ["Теплі", whole.warm, 0], ["Discovery", whole.discovery, 1], ["Кваліфіковані", whole.qualified, 2], ["Зараховано", whole.credited, 0]];
  const fMax = Math.max(1, funnel[0][1]);
  const quality = QUALITY.map(([k, l, act]) => [k, l, act, inPlan.filter(FLAGS[k].test).length]);

  $("#view").innerHTML = `
  <div class="kpis">
    <div class="kpi static"><div class="v">${passed}<small>/${totalDays}</small></div><div class="l">Днів циклу минуло</div><div class="s">${esc(fmtDate(cy.start))} – ${esc(fmtDate(cy.end))} · ${pace}% часу</div></div>
    <button class="kpi" data-q="inplan"><div class="v">${inPlan.length}</div><div class="l">Компаній у плані</div><div class="s">з позначкою «Місяць циклу»</div></button>
    <button class="kpi" data-q="notouch"><div class="v">${quality[1][3]}</div><div class="l">У плані без дотиків</div><div class="s">почати комунікацію</div></button>
    <button class="kpi ${quality[7][3] ? "accent" : ""}" data-q="overdue"><div class="v">${quality[7][3]}</div><div class="l">Прострочених дій</div><div class="s">${soon} дій на наступні 7 днів</div></button>
    <button class="kpi" data-q="credited"><div class="v">${whole.credited}</div><div class="l">Зараховано за цикл</div><div class="s">ціль ${targets.credited ?? "—"}</div></button>
  </div>

  <div class="panel" style="margin-bottom:12px">
    <h3>Ключові показники</h3>
    <div class="sub">Рахуються лише змістовні дотики. Риска на шкалі — де мали б бути за часом (${pace}% циклу)</div>
    <div class="tablewrap flat"><table class="metrics">
      <thead><tr><th>Показник</th>${periods.map(([l, a, b]) => `<th class="num" title="${esc(fmtDate(a))} – ${esc(fmtDate(b))}">${esc(l)}</th>`).join("")}<th class="num">Ціль циклу</th><th>Виконання</th></tr></thead>
      <tbody>${METRICS.map(([k, l]) => {
        const goal = targets[k] || 0, got = whole[k], p = pct(got, goal);
        return `<tr><td>${esc(l)}</td>${vals.map((v) => `<td class="num">${v[k]}</td>`).join("")}<td class="num">${goal || "—"}</td>
          <td>${goal ? `<div class="prog ${p >= pace ? "ahead" : ""}"><span style="width:${Math.min(100, p)}%"></span><i style="left:${pace}%"></i></div><div class="sub">${p}%</div>` : `<span class="faint">ціль не задано</span>`}</td></tr>`;
      }).join("")}</tbody>
    </table></div>
  </div>

  <div class="panel" style="margin-bottom:12px">
    <h3>Команда</h3>
    <div class="sub">План — компаній на місяць. Дотики й етапи — за автором дотику; «У плані» і «Зараховано» — за відповідальним компанії. Весь цикл</div>
    <div class="tablewrap flat"><table class="metrics">
      <thead><tr><th>Відповідальний</th><th class="num">План / міс.</th><th class="num">У плані</th><th class="num">Компаній з дотиками</th><th class="num">Дотиків</th><th class="num">Теплі</th><th class="num">Discovery</th><th class="num">Кваліф.</th><th class="num">Зараховано</th></tr></thead>
      <tbody>${teamRows.map((r) => `<tr data-owner="${esc(r.name)}"><td><b>${esc(r.name)}</b></td><td class="num">${r.plan}</td><td class="num">${r.inPlan}</td><td class="num">${r.companies}</td><td class="num">${r.touches}</td><td class="num">${r.warm}</td><td class="num">${r.discovery}</td><td class="num">${r.qualified}</td><td class="num">${r.credited}</td></tr>`).join("")}
        <tr class="total"><td>Команда</td><td class="num">${sum("plan")}</td><td class="num">${inPlan.length}</td><td class="num">${whole.companies}</td><td class="num">${whole.touches}</td><td class="num">${whole.warm}</td><td class="num">${whole.discovery}</td><td class="num">${whole.qualified}</td><td class="num">${whole.credited}</td></tr>
      </tbody>
    </table></div>
  </div>

  <div class="grid2">
    <div class="panel">
      <h3>Канали</h3>
      <div class="sub">Змістовні дотики за весь цикл</div>
      ${chRows.length ? chRows.map(([ch, n]) => `<div class="hbar static"><span class="lbl">${esc(CHANNELS[ch] || ch)}</span><span class="track"><span class="fill" style="width:${pct(n, chTotal)}%"></span></span><span class="n">${pct(n, chTotal)}%</span></div><div class="sub" style="margin:-2px 0 6px 6px">${n} ${plural(n, "дотик", "дотики", "дотиків")}</div>`).join("") : `<div class="faint">Ще немає змістовних дотиків у межах циклу</div>`}
    </div>
    <div class="panel">
      <h3>Воронка</h3>
      <div class="sub">Унікальні компанії за весь цикл; відсоток — перехід з попереднього етапу, для «Зараховано» — від компаній з дотиками</div>
      ${funnel.map(([l, n], i) => `<div class="funnel"><span class="lbl">${esc(l)}</span><span class="track"><span class="fill" style="width:${(n / fMax) * 100}%"></span></span><span class="n">${n}</span><span class="conv" title="${i ? `від «${esc(funnel[funnel[i][2]][0])}»` : ""}">${i ? `${pct(n, funnel[funnel[i][2]][1])}%` : ""}</span></div>`).join("")}
    </div>
  </div>

  <div class="panel" style="margin-bottom:12px">
    <h3>Якість даних</h3>
    <div class="sub">Серед ${inPlan.length} ${plural(inPlan.length, "компанії", "компаній", "компаній")} у плані циклу. Клік відкриває список</div>
    ${inPlan.length ? `<div class="quality">${quality.map(([k, l, act, n]) => `<button class="qrow ${n ? "" : "zero"}" data-q="${k}"><span class="n">${n}</span><span class="l">${esc(l)}</span><span class="act">${esc(act)}</span></button>`).join("")}</div>`
      : `<div class="faint">У плані поки немає компаній. Відкрийте картку компанії й оберіть «Місяць циклу».</div>`}
  </div>

  ${isAdmin ? `
  <form class="panel formgrid" id="cycleForm">
    <h3>Налаштування циклу</h3>
    <div class="sub">Бачать усі; змінює лише адміністратор</div>
    <div class="cyc-grid">
      <label class="mini"><span>Початок</span><input class="input" type="date" name="start" value="${esc(cy.start || "")}" required></label>
      <label class="mini"><span>Кінець</span><input class="input" type="date" name="end" value="${esc(cy.end || "")}" required></label>
    </div>
    <h4 class="formh">Цілі на цикл</h4>
    <div class="cyc-grid">${METRICS.map(([k, l]) => `<label class="mini"><span>${esc(l)}</span><input class="input" type="number" min="0" name="t_${k}" value="${targets[k] ?? 0}"></label>`).join("")}</div>
    <h4 class="formh">План: компаній на місяць</h4>
    <div class="cyc-grid">${state.teamUsers.map((u) => `<label class="mini"><span>${esc(u.name)}</span><input class="input" type="number" min="0" name="p_${u.id}" value="${cy.plan?.[u.id] ?? 0}"></label>`).join("")}</div>
    <div class="actions"><button class="btn primary" type="submit">Зберегти</button><span class="faint" id="cyMsg"></span></div>
  </form>` : ""}`;

  $("#view").querySelectorAll("[data-q]").forEach((el) => el.addEventListener("click", () => {
    const k = el.dataset.q;
    drill({ flags: k === "inplan" || k === "credited" ? [k] : ["inplan", k] });
  }));
  $("#view").querySelectorAll("[data-owner]").forEach((el) => el.addEventListener("click", () => drill({ owner: [el.dataset.owner], flags: ["inplan"] })));
  if (isAdmin) $("#cycleForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {
      start: f.start.value, end: f.end.value,
      targets: Object.fromEntries(METRICS.map(([k]) => [k, Number(f[`t_${k}`].value)])),
      plan: Object.fromEntries(state.teamUsers.map((u) => [u.id, Number(f[`p_${u.id}`].value)])),
    };
    try { const r = await api("set_cycle", body); state.cycle = r.cycle; renderCycle(); $("#cyMsg").innerHTML = `<span class="ok">Збережено</span>`; }
    catch (err) { $("#cyMsg").textContent = err.message; }
  });
}

// ---------- admin ----------
async function renderAdmin() {
  if (state.user.role !== "admin") return setView("overview");
  const a = state.admin;
  $("#view").innerHTML = `
  <div class="admin-grid">
    <div>
      <div class="panel" style="margin-bottom:12px">
        <h3>Користувачі</h3>
        <div class="sub">Нові акаунти отримують тимчасовий пароль і мусять змінити його при першому вході</div>
        <div class="tablewrap"><table>
          <thead><tr><th>Логін</th><th>Ім'я</th><th>Роль</th><th>Стан</th><th>Останній вхід</th><th></th></tr></thead>
          <tbody id="uRows"><tr><td colspan="6" class="faint">Завантаження…</td></tr></tbody>
        </table></div>
      </div>
      <div class="panel">
        <h3>Журнал синхронізації</h3>
        <div class="sub">Імпорт із Companies_KRS_dataset.xlsx (SharePoint) — щогодини автоматично або вручну</div>
        <div class="tablewrap"><table>
          <thead><tr><th>Час</th><th>Джерело</th><th>Рядків</th><th>Нових</th><th>Змінених</th></tr></thead>
          <tbody id="logRows"><tr><td colspan="5" class="faint">Завантаження…</td></tr></tbody>
        </table></div>
      </div>
    </div>
    <div>
      <form class="panel formgrid" id="newUser" style="margin-bottom:12px" autocomplete="off">
        <h3>Додати акаунт</h3>
        <label class="field"><span>Логін (латиниця)</span><input class="input" name="username" required pattern="[A-Za-z0-9._\\-]{3,40}"></label>
        <label class="field"><span>Ім'я для команди</span><input class="input" name="display_name" placeholder="напр. Олена К."></label>
        <label class="field"><span>Тимчасовий пароль</span>
          <div style="display:flex;gap:6px"><input class="input" name="password" required minlength="10" id="tmpPw"><button class="btn" type="button" id="genPw">Згенерувати</button></div></label>
        <label class="field"><span>Роль</span><select class="select" name="role"><option value="user">Користувач</option><option value="admin">Адміністратор</option></select></label>
        <div class="error" id="nuMsg"></div>
        <button class="btn primary" type="submit">Створити</button>
      </form>
      <form class="panel formgrid" id="upForm" style="margin-bottom:12px">
        <h3>Ручне оновлення бази</h3>
        <div class="sub">Завантажте свіжий .xlsx, якщо автоматичний імпорт не спрацював</div>
        <input class="input" type="file" accept=".xlsx" name="file" required>
        <div class="error" id="upMsg"></div>
        <button class="btn" type="submit">Імпортувати</button>
      </form>
      <div class="panel formgrid">
        <h3>Ключ автосинхронізації</h3>
        <div class="sub">Нового ключа потребуватиме щогодинне завдання. Старий одразу перестане діяти.</div>
        <div id="keyOut">${a.key ? `<div class="keybox">${esc(a.key)}</div><div class="hint" style="margin-top:6px">Показано один раз. Передайте його в налаштування завдання синхронізації.</div>` : ""}</div>
        <button class="btn danger" id="rotKey">Перевипустити ключ</button>
      </div>
    </div>
  </div>`;

  $("#genPw").addEventListener("click", () => { $("#tmpPw").value = genPassword(); });
  $("#newUser").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try {
      await api("create_user", fd);
      $("#nuMsg").innerHTML = `<span class="ok">Створено. Передайте логін «${esc(fd.username.toLowerCase())}» і пароль колезі особисто.</span>`;
      e.target.reset();
      loadAdminTables();
    } catch (err) { $("#nuMsg").textContent = err.message; }
  });
  $("#upForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = e.target.file.files[0];
    if (!file) return;
    $("#upMsg").textContent = "Імпортую…";
    try {
      const r = await api("upload_xlsx", { sheets: await fileToGrids(file) });
      $("#upMsg").innerHTML = `<span class="ok">Готово: ${r.total} рядків, нових ${r.inserted}, змінених ${r.updated}, вилучених ${r.removed}</span>`;
      loadAdminTables();
      loadData(true);
    } catch (err) { $("#upMsg").textContent = err.message; }
  });
  $("#rotKey").addEventListener("click", async () => {
    if (!confirm("Перевипустити ключ? Поточна щогодинна синхронізація перестане працювати, доки ключ не оновлять.")) return;
    try { const r = await api("rotate_ingest_key"); a.key = r.ingest_key; renderAdmin(); } catch (err) { alert(err.message); }
  });
  loadAdminTables();
}

async function loadAdminTables() {
  try {
    const [{ users }, { log }] = await Promise.all([api("list_users"), api("sync_log")]);
    const me = state.user.id;
    $("#uRows").innerHTML = users.map((u) => `
      <tr>
        <td><b>${esc(u.username)}</b></td>
        <td>${esc(u.display_name || "")}</td>
        <td>${u.role === "admin" ? "Адмін" : "Користувач"}</td>
        <td>${u.disabled ? `<span class="badge lo">заблоковано</span>` : u.must_change ? `<span class="badge mid">чекає зміни пароля</span>` : `<span class="badge hi">активний</span>`}
          ${u.locked_until && new Date(u.locked_until) > new Date() ? `<span class="badge lo">тимчасово заблоковано</span>` : ""}</td>
        <td class="num">${esc(fmtDT(u.last_login_at))}</td>
        <td><div class="user-actions">
          <button class="btn small" data-act="rename" data-id="${u.id}" data-u="${esc(u.username)}" data-name="${esc(u.display_name || "")}">Змінити ім'я</button>
          <button class="btn small" data-act="reset" data-id="${u.id}" data-u="${esc(u.username)}">Скинути пароль</button>
          ${u.id !== me ? `
          <button class="btn small" data-act="role" data-id="${u.id}" data-role="${u.role}">${u.role === "admin" ? "Зробити користувачем" : "Зробити адміном"}</button>
          <button class="btn small" data-act="toggle" data-id="${u.id}" data-dis="${u.disabled}">${u.disabled ? "Розблокувати" : "Заблокувати"}</button>
          <button class="btn small danger" data-act="del" data-id="${u.id}" data-u="${esc(u.username)}">Видалити</button>` : `<span class="faint">це ви</span>`}
        </div></td>
      </tr>`).join("");
    $("#logRows").innerHTML = log.length ? log.map((l) => `<tr><td class="num">${esc(fmtDT(l.at))}</td><td>${esc(l.source === "auto" ? "Автоматично" : l.source)}</td><td class="num">${l.total ?? ""}</td><td class="num">${l.inserted ?? ""}</td><td class="num">${l.updated ?? ""}</td></tr>`).join("")
      : `<tr><td colspan="5" class="faint">Ще не було імпортів</td></tr>`;
    $("#uRows").querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => userAction(b.dataset)));
  } catch (err) {
    $("#uRows").innerHTML = `<tr><td colspan="6" class="error">${esc(err.message)}</td></tr>`;
  }
}

async function userAction(ds) {
  try {
    if (ds.act === "rename") {
      const name = prompt(`Ім'я для «${ds.u}», як його бачитиме команда (відповідальний, автор дотиків):`, ds.name);
      if (name == null || !name.trim() || name.trim() === ds.name) return;
      await api("update_user", { id: ds.id, display_name: name.trim() });
      if (ds.id === state.user.id) {
        state.user.display_name = name.trim();
        $("#meName").textContent = name.trim();
      }
      await loadData(true);
    } else if (ds.act === "reset") {
      const pw = genPassword();
      if (!confirm(`Новий тимчасовий пароль для «${ds.u}»:\n\n${pw}\n\nСкопіюйте його зараз. Користувач змінить його при вході. Продовжити?`)) return;
      await api("update_user", { id: ds.id, password: pw });
    } else if (ds.act === "role") {
      await api("update_user", { id: ds.id, role: ds.role === "admin" ? "user" : "admin" });
    } else if (ds.act === "toggle") {
      await api("update_user", { id: ds.id, disabled: ds.dis !== "true" });
    } else if (ds.act === "del") {
      if (!confirm(`Видалити акаунт «${ds.u}»? Це не можна скасувати.`)) return;
      await api("delete_user", { id: ds.id });
    }
    loadAdminTables();
  } catch (err) { alert(err.message); }
}

function genPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  let s = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  if (!/\d/.test(s)) s = s.slice(0, -1) + "7";
  return s;
}

// The function runs out of CPU time parsing a large xlsx, so the browser reads it and sends rows.
let xlsxLib;
function loadXlsx() {
  xlsxLib ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "vendor/xlsx.mini.min.js";
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => { xlsxLib = null; reject(new Error("Не вдалося завантажити модуль читання Excel")); };
    document.head.append(s);
  });
  return xlsxLib;
}

async function fileToGrids(file) {
  const XLSX = await loadXlsx();
  const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array", cellDates: true, cellHTML: false, cellText: false, cellFormula: false });
  // Dates go as YYYY-MM-DD; SheetJS gives local midnight, so shift 12h to keep the day (same as the server).
  const cell = (v) => v instanceof Date ? (isNaN(v) ? null : new Date(v.getTime() + 12 * 3600000).toISOString().slice(0, 10)) : v;
  return Object.fromEntries(wb.SheetNames.map((n) => [n,
    XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null }).map((r) => r.map(cell))]));
}

// ---------- boot ----------
window.addEventListener("hashchange", () => {
  if (!state.user || state.user.must_change) return;
  const prevView = state.view, prevKrs = state.openKrs;
  readHash();
  if (state.view !== prevView) { markTabs(); renderView(); }
  if (state.openKrs && state.openKrs !== prevKrs) openDrawer(state.openKrs);
  else if (!state.openKrs && prevKrs) closeDrawer(true);
});

(async function boot() {
  state.token = tokenGet();
  if (!state.token) return renderLogin();
  try {
    const r = await api("me");
    state.user = r.user;
    afterAuth();
  } catch { renderLogin(); }
})();
