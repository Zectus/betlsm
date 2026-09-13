import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc,
  addDoc, writeBatch, increment, serverTimestamp, onSnapshot, query, orderBy,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyCcESCxa2tCxYfAt1PEi03Yxu5ZBXn0aUc",
  authDomain: "betlsm.firebaseapp.com",
  databaseURL: "https://betlsm-default-rtdb.firebaseio.com",
  projectId: "betlsm",
  storageBucket: "betlsm.firebasestorage.app",
  messagingSenderId: "470996500264",
  appId: "1:470996500264:web:51d3baa989bda42f591a1d"
};

// ------------------------------------------------------------------------------------

const STARTING_BALANCE = 1000;

// TODO keep this in sync with the UID inside firestore.rules so the
// commissioner drawer only appears for the right person. This is just UI
// polish -- the real enforcement happens in firestore.rules, so it's safe
// even if someone edits this in devtools.
const ADMIN_UIDS = ["pCcwMWcMoqX7KVRRS8tNa4BcpFp1"];

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

    let optionsHtml = "";
    ev.options.forEach((opt) => {
      const optTotal = bets.filter((b) => b.option === opt).reduce((a, b) => a + b.amount, 0);
      const isWinner = ev.status === "resolved" && ev.winningOption === opt;
      const inputId = `bet-${id}-${sanitize(opt)}`;
      optionsHtml += `<div class="option-row ${isWinner ? "winner" : ""}">
        <div>
          <div class="option-name">${escapeHtml(opt)}</div>
          <div class="option-meta">${optTotal.toLocaleString()} monedas apostadas</div>
        </div>
        ${ev.status === "open" && !myBet ? `
          <div class="bet-controls">
            <input type="number" min="1" placeholder="monedas" id="${inputId}">
            <button class="btn-amber place-bet-btn" data-event="${id}" data-option="${escapeHtml(opt)}">Apostar</button>
          </div>` : ""}
        ${isWinner ? '<span class="option-meta" style="color:var(--amber-earth);font-weight:700;">GANADOR</span>' : ""}
      </div>`;
    });

    card.innerHTML = `
      <div class="ticket-head">
        <div class="ticket-title">${escapeHtml(ev.title)}</div>
        <div class="status-tag ${ev.status}">${ev.status.toUpperCase()}</div>
      </div>
      <div class="pool-total">Bolsa total: ${totalPool.toLocaleString()} monedas · ${bets.length} apuesta${bets.length === 1 ? "" : "s"}</div>
      <div class="options">${optionsHtml}</div>
      ${myBet ? `<div class="your-bet-note">Apostaste ${myBet.amount.toLocaleString()} a "${escapeHtml(myBet.option)}"${ev.status === "resolved" ? ` — ${myBet.payout > 0 ? `ganaste ${myBet.payout.toLocaleString()}` : "no ganaste esta"}` : ""}</div>` : ""}
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
    return `<div style="margin-bottom:14px;padding:10px;border:1px solid var(--line);border-radius:8px;">
      <div style="font-size:13px;margin-bottom:6px;">${escapeHtml(ev.title)} <span style="opacity:0.5;">(${ev.status})</span></div>
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

async function placeBet(eventId, option) {
  if (!currentUser) return;
  const input = document.getElementById(`bet-${eventId}-${sanitize(option)}`);
  const amount = parseInt(input.value, 10);
  if (!amount || amount <= 0) { toast("Ingresa una cantidad de monedas"); return; }

  const me = usersCache[currentUser.uid];
  if (me && me.balance < amount) { toast("No tienes suficientes monedas"); return; }

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
      payout: null,
      createdAt: serverTimestamp(),
    });
    await batch.commit();
    toast(`Apuesta realizada: ${amount} monedas a ${option}`);
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
    const totalPool = bets.reduce((a, b) => a + b.amount, 0);
    const winners = bets.filter((b) => b.option === winningOption);
    const winningStakeTotal = winners.reduce((a, b) => a + b.amount, 0);

    const batch = writeBatch(db);

    if (winningStakeTotal === 0) {
      // nobody backed the winner -- refund everyone their own stake
      bets.forEach((b) => {
        batch.update(b.ref, { payout: b.amount });
        batch.update(doc(db, "users", b.uid), { balance: increment(b.amount) });
      });
    } else {
      bets.forEach((b) => {
        if (b.option === winningOption) {
          const share = b.amount / winningStakeTotal;
          const payout = Math.round(share * totalPool);
          batch.update(b.ref, { payout });
          if (payout > 0) batch.update(doc(db, "users", b.uid), { balance: increment(payout) });
        } else {
          batch.update(b.ref, { payout: 0 });
        }
      });
    }

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

document.getElementById("create-event")?.addEventListener("click", async () => {
  const title = document.getElementById("new-event-title").value.trim();
  const optionsRaw = document.getElementById("new-event-options").value.trim();
  const options = optionsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!title || options.length < 2) { toast("Agrega un título y al menos 2 opciones"); return; }
  try {
    await addDoc(collection(db, "events"), {
      title,
      options,
      status: "open",
      winningOption: null,
      createdBy: currentUser.uid,
      createdAt: serverTimestamp(),
    });
    document.getElementById("new-event-title").value = "";
    document.getElementById("new-event-options").value = "";
    toast("Evento creado");
  } catch (e) {
    console.error(e);
    toast("No se pudo crear el evento");
  }
});
