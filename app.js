import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc,
  addDoc, writeBatch, increment, serverTimestamp, onSnapshot, query, orderBy,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---- Fill this in from Firebase Console -> Project settings -> General -> Your apps ----
const firebaseConfig = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.appspot.com",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME",
};
// ------------------------------------------------------------------------------------

const STARTING_BALANCE = 1000;

// TODO keep this in sync with the UID inside firestore.rules so the
// commissioner drawer only appears for the right person. This is just UI
// polish -- the real enforcement happens in firestore.rules, so it's safe
// even if someone edits this in devtools.
const ADMIN_UIDS = ["REPLACE_WITH_YOUR_FIREBASE_AUTH_UID"];

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let currentUser = null;
let usersCache = {};
let eventsCache = {};
let betsByEvent = {}; // eventId -> array of bet docs (with .ref attached)

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2400);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function sanitize(s) { return String(s).replace(/[^a-zA-Z0-9]/g, ""); }

// ---------- auth ----------

async function ensureUserDoc(user) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      displayName: user.displayName || "Jugador",
      photoURL: user.photoURL || null,
      balance: STARTING_BALANCE,
      createdAt: serverTimestamp(),
    });
  }
}

async function doSignIn() {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    console.error(e);
    toast("No se pudo iniciar sesión — intenta de nuevo");
  }
}

document.getElementById("signin-btn").addEventListener("click", doSignIn);

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  document.getElementById("main-content").style.display = user ? "block" : "none";
  document.getElementById("signed-out-content").style.display = user ? "none" : "block";

  if (user) {
    await ensureUserDoc(user);
    document.getElementById("commish-drawer").style.display =
      ADMIN_UIDS.includes(user.uid) ? "block" : "none";
    startListeners();
  }
  renderYouCard();
});

function renderYouCard() {
  const el = document.getElementById("you-card");
  if (!currentUser) {
    el.innerHTML = '<button class="signin-btn" id="signin-btn">Iniciar sesión con Google</button>';
    document.getElementById("signin-btn").addEventListener("click", doSignIn);
    return;
  }
  const me = usersCache[currentUser.uid];
  const balance = me ? me.balance.toLocaleString() : "…";
  el.innerHTML = `
    <div>
      <div class="label">Jugando como</div>
      <div class="display" style="font-size:15px;text-transform:none;font-weight:600;">
        ${currentUser.photoURL ? `<img src="${currentUser.photoURL}">` : ""}${escapeHtml(currentUser.displayName || "Jugador")}
      </div>
    </div>
    <div style="text-align:right;">
      <div class="balance">${balance}</div>
      <button class="signout-btn" id="signout-btn">salir</button>
    </div>
  `;
  document.getElementById("signout-btn").addEventListener("click", () => signOut(auth));
}

// ---------- live data ----------

let listenersStarted = false;
function startListeners() {
  if (listenersStarted) return;
  listenersStarted = true;

  onSnapshot(collection(db, "users"), (snap) => {
    usersCache = {};
    snap.forEach((d) => (usersCache[d.id] = { uid: d.id, ...d.data() }));
    renderYouCard();
    renderStandings();
  });

  onSnapshot(query(collection(db, "events"), orderBy("createdAt", "desc")), (snap) => {
    eventsCache = {};
    snap.forEach((d) => (eventsCache[d.id] = { id: d.id, ...d.data() }));
    renderEvents();
    renderResolveSection();
    attachBetListeners();
  });
}

const attachedBetListeners = new Set();
function attachBetListeners() {
  Object.keys(eventsCache).forEach((eventId) => {
    if (attachedBetListeners.has(eventId)) return;
    attachedBetListeners.add(eventId);
    onSnapshot(collection(db, "events", eventId, "bets"), (snap) => {
      betsByEvent[eventId] = snap.docs.map((d) => ({ ref: d.ref, ...d.data() }));
      renderEvents();
    });
  });
}

// ---------- rendering ----------

function renderEvents() {
  const list = document.getElementById("events-list");
  const ids = Object.keys(eventsCache);
  if (!ids.length) {
    list.innerHTML = '<div class="empty-note">Todavía no hay eventos. Pídele al comisionado que cree uno.</div>';
    return;
  }

  const sorted = [...ids].sort((a, b) => {
    const rank = (s) => (s === "open" ? 0 : s === "locked" ? 1 : 2);
    return rank(eventsCache[a].status) - rank(eventsCache[b].status);
  });

  list.innerHTML = "";
  sorted.forEach((id) => {
    const ev = eventsCache[id];
    const bets = betsByEvent[id] || [];
    const totalPool = bets.reduce((a, b) => a + b.amount, 0);
    const myBet = currentUser ? bets.find((b) => b.uid === currentUser.uid) : null;

    const card = document.createElement("div");
    card.className = "ticket " + (ev.status === "locked" ? "locked" : ev.status === "resolved" ? "resolved" : "");

    let oddsHtml = "";
    ev.options.forEach((opt) => {
      const betsOnOpt = bets.filter((b) => b.option === opt).length;
      const isWinner = ev.status === "resolved" && ev.winningOption === opt;
      const cuota = ev.odds[opt];
      const inputId = `bet-${id}-${sanitize(opt)}`;
      const previewId = `preview-${id}-${sanitize(opt)}`;
      oddsHtml += `<div class="odds-box ${isWinner ? "winner" : ""}">
        <div class="odds-option-name">${escapeHtml(opt)}</div>
        <div class="odds-value">${cuota.toFixed(2)}</div>
        <div class="odds-meta">${betsOnOpt} apuesta${betsOnOpt === 1 ? "" : "s"}${isWinner ? " · GANADOR" : ""}</div>
        ${ev.status === "open" && !myBet ? `
          <div class="bet-controls">
            <input type="number" min="1" placeholder="monedas" id="${inputId}"
              oninput="window.updatePayoutPreview('${id}', ${JSON.stringify(opt)}, '${previewId}')">
            <button class="btn-amber place-bet-btn" data-event="${id}" data-option="${escapeHtml(opt)}">Apostar</button>
          </div>
          <div class="payout-preview" id="${previewId}"></div>` : ""}
      </div>`;
    });

    card.innerHTML = `
      <div class="ticket-head">
        <div class="ticket-title">${escapeHtml(ev.title)}</div>
        <div class="status-tag ${ev.status}">${ev.status.toUpperCase()}</div>
      </div>
      <div class="pool-total">${bets.length} apuesta${bets.length === 1 ? "" : "s"} · ${totalPool.toLocaleString()} monedas en juego</div>
      <div class="odds-row">${oddsHtml}</div>
      ${myBet ? `<div class="your-bet-note">Apostaste ${myBet.amount.toLocaleString()} a "${escapeHtml(myBet.option)}" a cuota ${myBet.oddsAtBet.toFixed(2)}${ev.status === "resolved" ? ` — ${myBet.payout > 0 ? `ganaste ${myBet.payout.toLocaleString()}` : "no ganaste esta"}` : ` (pagaría ${Math.round(myBet.amount * myBet.oddsAtBet).toLocaleString()})`}</div>` : ""}
    `;
    list.appendChild(card);
  });

  list.querySelectorAll("button[data-event]").forEach((btn) => {
    btn.addEventListener("click", () => placeBet(btn.dataset.event, btn.dataset.option));
  });
}

function renderStandings() {
  const el = document.getElementById("standings-list");
  const users = Object.values(usersCache).sort((a, b) => b.balance - a.balance);
  if (!users.length) {
    el.innerHTML = '<div class="empty-note">Todavía no hay jugadores.</div>';
    return;
  }
  el.innerHTML = users.map((u, i) => `
    <div class="standing-row ${currentUser && u.uid === currentUser.uid ? "you" : ""}">
      <div class="rank">${i + 1}</div>
      <div class="sname">${escapeHtml(u.displayName)}</div>
      <div class="sbal">${u.balance.toLocaleString()}</div>
    </div>
  `).join("");
}

function renderResolveSection() {
  const el = document.getElementById("resolve-section");
  if (!currentUser || !ADMIN_UIDS.includes(currentUser.uid)) { el.innerHTML = ""; return; }
  const openOrLocked = Object.values(eventsCache).filter((e) => e.status !== "resolved");
  if (!openOrLocked.length) {
    el.innerHTML = '<div class="empty-note">No hay eventos pendientes de cerrar o resolver.</div>';
    return;
  }
  el.innerHTML = "<label>Gestionar eventos</label>" + openOrLocked.map((ev) => {
    const optButtons = ev.options.map((opt) =>
      `<button class="btn-ghost resolve-btn" data-event="${ev.id}" data-option="${escapeHtml(opt)}" style="margin:4px 4px 0 0;">Resolver: gana ${escapeHtml(opt)}</button>`
    ).join("");
    const oddsEditors = ev.status === "open" ? ev.options.map((opt) => `
      <span style="display:inline-flex;align-items:center;gap:4px;margin:4px 8px 4px 0;">
        <span style="font-size:12px;opacity:0.7;">${escapeHtml(opt)}</span>
        <input type="text" value="${ev.odds[opt].toFixed(2)}" placeholder="4.25 o 20%"
          id="odds-edit-${ev.id}-${sanitize(opt)}" style="width:70px;">
        <button class="btn-ghost" style="padding:4px 8px;" onclick="window.updateOdds('${ev.id}', ${JSON.stringify(opt)})">Fijar</button>
      </span>`).join("") : "";
    return `<div style="margin-bottom:14px;padding:10px;border:1px solid var(--line);border-radius:8px;">
      <div style="font-size:13px;margin-bottom:6px;">${escapeHtml(ev.title)} <span style="opacity:0.5;">(${ev.status})</span></div>
      ${oddsEditors ? `<div style="margin-bottom:8px;">${oddsEditors}</div>` : ""}
      ${ev.status === "open" ? `<button class="btn-lockout lock-btn" data-event="${ev.id}">Cerrar apuestas</button>` : ""}
      <div style="margin-top:6px;">${optButtons}</div>
    </div>`;
  }).join("");

  el.querySelectorAll(".lock-btn").forEach((btn) =>
    btn.addEventListener("click", () => lockEvent(btn.dataset.event))
  );
  el.querySelectorAll(".resolve-btn").forEach((btn) =>
    btn.addEventListener("click", () => resolveEvent(btn.dataset.event, btn.dataset.option))
  );
}

// ---------- actions (direct Firestore writes, guarded by firestore.rules) ----------

window.updatePayoutPreview = function (eventId, option, previewId) {
  const input = document.getElementById(`bet-${eventId}-${sanitize(option)}`);
  const preview = document.getElementById(previewId);
  if (!input || !preview) return;
  const amount = parseInt(input.value, 10);
  const ev = eventsCache[eventId];
  if (!amount || amount <= 0 || !ev) { preview.textContent = ""; return; }
  const payout = Math.round(amount * ev.odds[option]);
  preview.textContent = `Ganancia potencial: ${payout.toLocaleString()} monedas`;
};

async function placeBet(eventId, option) {
  if (!currentUser) return;
  const input = document.getElementById(`bet-${eventId}-${sanitize(option)}`);
  const amount = parseInt(input.value, 10);
  if (!amount || amount <= 0) { toast("Ingresa una cantidad de monedas"); return; }

  const me = usersCache[currentUser.uid];
  if (me && me.balance < amount) { toast("No tienes suficientes monedas"); return; }

  const ev = eventsCache[eventId];
  const oddsAtBet = ev.odds[option];
  const uid = currentUser.uid;
  const userRef = doc(db, "users", uid);
  const betRef = doc(db, "events", eventId, "bets", uid);

  try {
    const batch = writeBatch(db);
    batch.update(userRef, { balance: increment(-amount) });
    batch.set(betRef, {
      uid,
      eventId,
      displayName: currentUser.displayName || "Jugador",
      option,
      amount,
      oddsAtBet,
      payout: null,
      createdAt: serverTimestamp(),
    });
    await batch.commit();
    toast(`Apuesta realizada: ${amount} monedas a ${option} (cuota ${oddsAtBet.toFixed(2)})`);
  } catch (e) {
    console.error(e);
    toast("No se pudo registrar la apuesta (¿ya apostaste, o el evento se cerró?)");
  }
}

async function lockEvent(eventId) {
  try {
    await updateDoc(doc(db, "events", eventId), { status: "locked" });
    toast("Apuestas cerradas");
  } catch (e) {
    console.error(e);
    toast("No se pudo cerrar el evento");
  }
}

async function resolveEvent(eventId, winningOption) {
  const ev = eventsCache[eventId];
  if (!confirm(`¿Resolver "${ev.title}" con ganador: ${winningOption}? Esto paga de inmediato.`)) return;

  try {
    const betsSnap = await getDocs(collection(db, "events", eventId, "bets"));
    const bets = betsSnap.docs.map((d) => ({ ref: d.ref, ...d.data() }));

    // Fixed odds: each bet settles on its own, independent of every other
    // bet -- payout = stake x the odds that were live when it was placed.
    // No pool math needed at all.
    const batch = writeBatch(db);
    bets.forEach((b) => {
      if (b.option === winningOption) {
        const payout = Math.round(b.amount * b.oddsAtBet);
        batch.update(b.ref, { payout });
        if (payout > 0) batch.update(doc(db, "users", b.uid), { balance: increment(payout) });
      } else {
        batch.update(b.ref, { payout: 0 });
      }
    });

    batch.update(doc(db, "events", eventId), { status: "resolved", winningOption });
    await batch.commit();
    toast("Evento resuelto y monedas repartidas");
  } catch (e) {
    console.error(e);
    toast("No se pudo resolver el evento");
  }
}

document.getElementById("drawer-toggle")?.addEventListener("click", () => {
  document.getElementById("drawer-body").classList.toggle("open");
});

// ---------- per-option rows for the create-event form (real textboxes,
// no comma/colon syntax to remember) ----------

let optionRowCounter = 0;

function addOptionRow(name = "", odds = "") {
  const container = document.getElementById("option-rows");
  const row = document.createElement("div");
  row.className = "option-row-input";
  row.dataset.rowId = `opt-row-${optionRowCounter++}`;
  row.innerHTML = `
    <input type="text" class="opt-name" placeholder="Nombre de la opción" value="${escapeHtml(name)}">
    <input type="text" class="opt-odds" placeholder="4.25 o 20%" value="${escapeHtml(odds)}">
    <button type="button" class="remove-row-btn" title="Quitar opción">×</button>
  `;
  container.appendChild(row);
  row.querySelector(".remove-row-btn").addEventListener("click", () => {
    if (container.children.length <= 2) { toast("Se necesitan al menos 2 opciones"); return; }
    row.remove();
    updateOverroundFromRows();
  });
}

function resetOptionRows() {
  const container = document.getElementById("option-rows");
  if (!container) return;
  container.innerHTML = "";
  addOptionRow();
  addOptionRow();
  updateOverroundFromRows();
}

function readOptionRows() {
  return Array.from(document.querySelectorAll("#option-rows .option-row-input")).map((row) => ({
    name: row.querySelector(".opt-name").value.trim(),
    oddsRaw: row.querySelector(".opt-odds").value.trim(),
  }));
}

// Accepts either a decimal cuota ("4.25") or an implied probability
// written as a percentage ("20%", which becomes cuota 100/20 = 5.00).
// Returns null if the text isn't a valid cuota either way.
function parseOddsInput(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.endsWith("%")) {
    const pct = parseFloat(s.slice(0, -1));
    if (isNaN(pct) || pct <= 0 || pct > 100) return null;
    return Math.round((100 / pct) * 100) / 100;
  }
  const val = parseFloat(s);
  if (isNaN(val) || val <= 1) return null;
  return val;
}

function updateOverroundFromRows() {
  const el = document.getElementById("overround-indicator");
  const rows = readOptionRows().filter((r) => r.name);
  if (rows.length < 2) { el.textContent = ""; return; }

  const withOdds = rows
    .map((r) => ({ name: r.name, odds: parseOddsInput(r.oddsRaw) }))
    .filter((r) => r.odds !== null);

  if (!withOdds.length) { el.textContent = ""; return; }

  const pct = withOdds.reduce((a, r) => a + 1 / r.odds, 0) * 100;
  const missingCount = rows.length - withOdds.length;
  let verdict = "cuotas justas";
  if (pct > 101) verdict = "con margen (las monedas del grupo bajarán con el tiempo)";
  if (pct < 99) verdict = "cuotas generosas (las monedas del grupo subirán con el tiempo)";
  const missingNote = missingCount
    ? ` (calculado con ${withOdds.length} de ${rows.length} opciones — completa las demás para ver el total real)`
    : "";
  el.textContent = `Suma de probabilidades implícitas: ${pct.toFixed(1)}%${missingNote} — ${verdict}`;
}

document.getElementById("option-rows")?.addEventListener("input", updateOverroundFromRows);
document.getElementById("add-option-row")?.addEventListener("click", () => addOptionRow());
resetOptionRows();

document.getElementById("create-event")?.addEventListener("click", async () => {
  const title = document.getElementById("new-event-title").value.trim();
  const rows = readOptionRows().filter((r) => r.name);

  if (!title || rows.length < 2) { toast("Agrega un título y al menos 2 opciones"); return; }

  const names = rows.map((r) => r.name);
  if (new Set(names).size !== names.length) { toast("Los nombres de las opciones deben ser únicos"); return; }

  const odds = {};
  const missing = [];
  rows.forEach((r) => {
    const val = parseOddsInput(r.oddsRaw);
    if (val !== null) odds[r.name] = val; else missing.push(r.name);
  });
  if (missing.length) {
    // fill any option left without a valid cuota with an even split of
    // whatever probability isn't already claimed by the others
    const claimed = Object.values(odds).reduce((a, o) => a + 1 / o, 0);
    const remaining = Math.max(1 - claimed, 0.0001);
    const evenOdds = missing.length / remaining;
    missing.forEach((name) => (odds[name] = Math.round(evenOdds * 100) / 100));
  }

  try {
    await addDoc(collection(db, "events"), {
      title,
      options: names,
      odds,
      status: "open",
      winningOption: null,
      createdBy: currentUser.uid,
      createdAt: serverTimestamp(),
    });
    document.getElementById("new-event-title").value = "";
    resetOptionRows();
    toast("Evento creado");
  } catch (e) {
    console.error(e);
    toast("No se pudo crear el evento");
  }
});

// Lets the commissioner move a specific option's odds while the event is
// still open -- like a real sportsbook's line moving. Bets already placed
// keep whatever odds they locked in; only new bets see the change.
window.updateOdds = async function (eventId, option) {
  const input = document.getElementById(`odds-edit-${eventId}-${sanitize(option)}`);
  const newOdds = parseOddsInput(input.value);
  if (newOdds === null) { toast("Escribe una cuota (ej. 4.25) o un porcentaje (ej. 20%)"); return; }
  const ev = eventsCache[eventId];
  const newOddsMap = { ...ev.odds, [option]: newOdds };
  try {
    await updateDoc(doc(db, "events", eventId), { odds: newOddsMap });
    toast(`Cuota de "${option}" actualizada a ${newOdds.toFixed(2)}`);
  } catch (e) {
    console.error(e);
    toast("No se pudo actualizar la cuota");
  }
};
