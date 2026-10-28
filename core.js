(() => {
// Forbrug core — pure state logic shared by the desktop extension and the phone app (build-pwa.mjs).
// Must stay free of Node/browser-specific imports.

const WHO = ["mig", "boern", "os"];
const WHO_LABEL = { mig: "Mig selv", boern: "Børnene", os: "Mig & min mand" };
const DEFAULT_CARDS = ["Visa/Dankort", "Mastercard", "Klarna"];
const DEFAULT_CHILD_BENEFIT = { next: "2027-01-20", everyMonths: 3 };
const BALANCE_WHO = ["mig", "boern"];

// Fields that are merged "last write wins" using st.ts[key].
const LWW_FIELDS = ["cards", "childBenefit", ...WHO.map((w) => "budget:" + w), ...BALANCE_WHO.map((w) => "balance:" + w)];

class FbError extends Error {
    constructor(code, message) { super(message); this.code = code; this.fb = true; }
}

const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD local

const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
const byCreated = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id));
const uniqSorted = (xs) => [...new Set(xs.map(String))].sort();

function emptyState() {
    return normalize({});
}

// Returns a canonical copy: fixed key order, tombstoned items removed, deterministic sorting.
function normalize(d) {
    d = obj(d);
    const del = obj(d.deleted);
    const deleted = { purchases: uniqSorted(arr(del.purchases)), sales: uniqSorted(arr(del.sales)) };
    const dp = new Set(deleted.purchases), ds = new Set(deleted.sales);
    const cards = arr(d.cards).map(String).filter(Boolean);
    const ts = {};
    for (const [k, v] of Object.entries(obj(d.ts))) if (LWW_FIELDS.includes(k) && Number.isFinite(v)) ts[k] = v;
    return {
        version: 2,
        purchases: arr(d.purchases).filter((p) => p && p.id && !dp.has(p.id)).sort(byCreated),
        cards: cards.length ? cards : [...DEFAULT_CARDS],
        budgets: sortKeys(obj(d.budgets)),
        sales: arr(d.sales).filter((s) => s && s.id && !ds.has(s.id)).sort(byCreated),
        balances: sortKeys(obj(d.balances)),
        childBenefit: d.childBenefit && d.childBenefit.next ? d.childBenefit : { ...DEFAULT_CHILD_BENEFIT },
        deleted,
        ts: sortKeys(ts),
    };
}

const fingerprint = (st) => JSON.stringify(normalize(st));

function getField(st, k) {
    if (k === "cards") return st.cards;
    if (k === "childBenefit") return st.childBenefit;
    const [kind, w] = k.split(":");
    return (kind === "budget" ? st.budgets[w] : st.balances[w]) ?? null;
}
function setField(st, k, v) {
    if (k === "cards") { st.cards = v; return; }
    if (k === "childBenefit") { st.childBenefit = v; return; }
    const [kind, w] = k.split(":");
    const target = kind === "budget" ? st.budgets : st.balances;
    if (v === null || v === undefined) delete target[w]; else target[w] = v;
}

function touch(st, k) {
    st.ts[k] = Math.max(Date.now(), (st.ts[k] || 0) + 1);
}

// Commutative, idempotent merge of two states.
function merge(a, b) {
    a = normalize(a); b = normalize(b);
    const out = normalize({
        deleted: {
            purchases: [...a.deleted.purchases, ...b.deleted.purchases],
            sales: [...a.deleted.sales, ...b.deleted.sales],
        },
    });
    const union = (x, y) => { const m = new Map(); for (const it of [...y, ...x]) m.set(it.id, it); return [...m.values()]; };
    out.purchases = union(a.purchases, b.purchases);
    out.sales = union(a.sales, b.sales);
    out.budgets = {}; out.balances = {};
    for (const k of LWW_FIELDS) {
        const ta = a.ts[k] || 0, tb = b.ts[k] || 0;
        const va = getField(a, k), vb = getField(b, k);
        let win;
        if (ta !== tb) win = ta > tb ? va : vb;
        else if (va === null || vb === null) win = va ?? vb; // tie: keep a value over nothing
        else {
            const [hi, lo] = JSON.stringify(va) >= JSON.stringify(vb) ? [va, vb] : [vb, va]; // deterministic tie-break
            win = k === "cards" ? [...new Set([...hi, ...lo])] : hi;
        }
        setField(out, k, win);
        if (Math.max(ta, tb)) out.ts[k] = Math.max(ta, tb);
    }
    return normalize(out);
}

function parseAmount(a) {
    const n = typeof a === "number" ? a : Number(String(a).replace(/\s|kr\.?/gi, "").replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) throw new FbError("invalid_input", "Beløb skal være et tal over 0");
    return Math.round(n * 100) / 100;
}

function parseSigned(a) {
    const n = typeof a === "number" ? a : Number(String(a).replace(/\s|kr\.?/gi, "").replace(/\./g, "").replace(",", ".").replace("−", "-"));
    if (!Number.isFinite(n)) throw new FbError("invalid_input", "Saldo skal være et tal");
    return Math.round(n * 100) / 100;
}

function normWho(w) {
    const s = String(w || "").toLowerCase();
    if (WHO.includes(s)) return s;
    if (/b(ø|oe)rn|kid/.test(s)) return "boern";
    if (/mand|os|vi|begge|fælles|husband/.test(s)) return "os";
    if (/mig|selv|me/.test(s)) return "mig";
    throw new FbError("invalid_input", `Ukendt "hvem": ${w}. Brug mig, boern eller os`);
}

const validDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || "") ? d : today());

// ---- Mutations (modify st in place, return a result) ----

function addPurchase(st, input) {
    const card = String(input.card || "").trim();
    if (!card) throw new FbError("invalid_input", "Vælg et kort");
    if (!st.cards.some((c) => c.toLowerCase() === card.toLowerCase())) { st.cards = [...st.cards, card]; touch(st, "cards"); }
    const p = {
        id: crypto.randomUUID(),
        date: validDate(input.date),
        amount: parseAmount(input.amount),
        what: String(input.what || "").trim(),
        card: st.cards.find((c) => c.toLowerCase() === card.toLowerCase()),
        who: normWho(input.who),
        createdAt: new Date().toISOString(),
    };
    st.purchases.push(p);
    return p;
}

function deletePurchase(st, id) {
    if (!st.purchases.some((p) => p.id === id)) throw new FbError("not_found", "Købet findes ikke");
    st.purchases = st.purchases.filter((p) => p.id !== id);
    st.deleted.purchases.push(id);
    return { deleted: id };
}

function addSale(st, input) {
    const s = {
        id: crypto.randomUUID(),
        date: validDate(input.date),
        amount: parseAmount(input.amount),
        what: String(input.what || "").trim(),
        who: "mig",
        createdAt: new Date().toISOString(),
    };
    st.sales.push(s);
    return s;
}

function deleteSale(st, id) {
    if (!st.sales.some((s) => s.id === id)) throw new FbError("not_found", "Salget findes ikke");
    st.sales = st.sales.filter((s) => s.id !== id);
    st.deleted.sales.push(id);
    return { deleted: id };
}

function setBalance(st, { who, amount }) {
    const w = normWho(who);
    if (!BALANCE_WHO.includes(w)) throw new FbError("invalid_input", "Saldo kan kun sættes for mig eller boern");
    st.balances[w] = { amount: parseSigned(amount), at: new Date().toISOString() };
    touch(st, "balance:" + w);
    return balancesNow(st);
}

function setBudget(st, { who, amount }) {
    const w = normWho(who);
    if (amount === null || amount === "" || amount === 0) delete st.budgets[w];
    else st.budgets[w] = parseAmount(amount);
    touch(st, "budget:" + w);
    return st.budgets;
}

function setCards(st, cards) {
    st.cards = [...new Set((cards || []).map((c) => String(c).trim()).filter(Boolean))];
    if (!st.cards.length) st.cards = [...DEFAULT_CARDS];
    touch(st, "cards");
    return st.cards;
}

// ---- Read-only ----

// Saldo = sidst indtastede beløb − køb registreret efter + salg registreret efter (kun mig).
function balancesNow(st) {
    const out = {};
    for (const w of BALANCE_WHO) {
        const b = st.balances[w];
        if (!b) { out[WHO_LABEL[w]] = null; continue; }
        const spent = st.purchases.filter((p) => p.who === w && p.createdAt > b.at).reduce((s, p) => s + p.amount, 0);
        const sold = w === "mig" ? st.sales.filter((s) => s.createdAt > b.at).reduce((s, x) => s + x.amount, 0) : 0;
        out[WHO_LABEL[w]] = { now: Math.round((b.amount - spent + sold) * 100) / 100, lastEntered: b.amount, updatedAt: b.at };
    }
    return out;
}

function summary(st, month) {
    const m = /^\d{4}-\d{2}$/.test(month || "") ? month : today().slice(0, 7);
    const list = st.purchases.filter((p) => p.date.startsWith(m));
    const sales = st.sales.filter((s) => s.date.startsWith(m));
    const out = { month: m, total: 0, byWho: {}, byCard: {}, purchases: list, sales, salesTotal: sales.reduce((s, x) => s + x.amount, 0), balances: balancesNow(st), childBenefit: st.childBenefit };
    for (const w of WHO) out.byWho[WHO_LABEL[w]] = { total: 0, budget: st.budgets[w] ?? null, byCard: {} };
    for (const p of list) {
        const g = out.byWho[WHO_LABEL[p.who]];
        g.total += p.amount;
        g.byCard[p.card] = (g.byCard[p.card] || 0) + p.amount;
        out.byCard[p.card] = (out.byCard[p.card] || 0) + p.amount;
        out.total += p.amount;
    }
    return out;
}

// Routes the same HTTP-style API the UI uses onto a state object. Returns { result, mutated }.
function route(st, method, path, body = {}) {
    if (method === "GET" && path === "/api/state") return { result: st, mutated: false };
    if (method === "POST" && path === "/api/purchases") return { result: addPurchase(st, body), mutated: true };
    if (method === "DELETE" && path.startsWith("/api/purchases/")) return { result: deletePurchase(st, decodeURIComponent(path.slice(15))), mutated: true };
    if (method === "POST" && path === "/api/sales") return { result: addSale(st, body), mutated: true };
    if (method === "DELETE" && path.startsWith("/api/sales/")) return { result: deleteSale(st, decodeURIComponent(path.slice(11))), mutated: true };
    if (method === "POST" && path === "/api/balance") return { result: setBalance(st, body), mutated: true };
    if (method === "POST" && path === "/api/budget") return { result: setBudget(st, body), mutated: true };
    if (method === "POST" && path === "/api/cards") return { result: setCards(st, body.cards), mutated: true };
    throw new FbError("not_found", "not found");
}

// ---- GitHub sync (fetch-based; works in Node 18+ and browsers) ----

const b64encode = (s) => { const bytes = new TextEncoder().encode(s); let bin = ""; for (const x of bytes) bin += String.fromCharCode(x); return btoa(bin); };
const b64decode = (s) => { const bin = atob(s.replace(/\s/g, "")); return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); };

async function ghGet({ token, repo, path = "data.json" }) {
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?t=${Date.now()}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        cache: "no-store",
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new FbError("sync_failed", `GitHub svarede ${r.status}`);
    const j = await r.json();
    return { sha: j.sha, state: JSON.parse(b64decode(j.content)) };
}

async function ghPut({ token, repo, path = "data.json" }, state, sha, who) {
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ message: `Opdatér forbrug (${who})`, content: b64encode(JSON.stringify(normalize(state), null, 1)), ...(sha ? { sha } : {}) }),
    });
    if (r.status === 409 || r.status === 422) return false; // someone else wrote first — retry
    if (!r.ok) throw new FbError("sync_failed", `GitHub svarede ${r.status}`);
    return true;
}

// Pull → merge into local → push if remote is behind. readLocal/writeLocal let callers guard local writes.
async function syncOnce(cfg, { readLocal, writeLocal, who }) {
    for (let i = 0; i < 4; i++) {
        const remote = await ghGet(cfg);
        const local = await readLocal();
        const merged = merge(local, remote ? remote.state : {});
        if (fingerprint(merged) !== fingerprint(local)) await writeLocal(merged);
        if (remote && fingerprint(merged) === fingerprint(remote.state)) return merged;
        if (await ghPut(cfg, merged, remote && remote.sha, who)) return merged;
    }
    throw new FbError("sync_failed", "Kunne ikke synkronisere — prøv igen");
}

window.ForbrugCore = { WHO, WHO_LABEL, DEFAULT_CARDS, DEFAULT_CHILD_BENEFIT, BALANCE_WHO, LWW_FIELDS, FbError, today, emptyState, normalize, fingerprint, touch, merge, parseAmount, parseSigned, normWho, addPurchase, deletePurchase, addSale, deleteSale, setBalance, setBudget, setCards, balancesNow, summary, route, ghGet, ghPut, syncOnce };
})();
