// Firebase Cloud Database para o BI Embalagens (acesso direto pelo link, SEM login)
// Usa o mesmo projeto do Espelho SMA, mas outra coleção (biEmbalagens): um não sobrescreve os dados do outro.
// Compatível com GitHub Pages / HTML estático: usa o SDK modular via CDN.

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  initializeFirestore,
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  writeBatch,
  onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBLBnVXc_mmnpnjMVbgiX5CWPyz0g_EvGw",
  authDomain: "bi-gns.firebaseapp.com",
  projectId: "bi-gns",
  storageBucket: "bi-gns.firebasestorage.app",
  messagingSenderId: "51774117422",
  appId: "1:51774117422:web:d46aab8e38e7a0214a71bf"
};

const app = initializeApp(firebaseConfig);
// Detecta automaticamente redes (ex.: proxy/firewall de empresa) que bloqueiam a conexão padrão.
const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });

const ROOT = "biEmbalagens";
const CURRENT_DOC = "current";
const CHUNK_RAW = 150_000;   // sem compressão: margem segura abaixo de 1 MiB/documento
const CHUNK_GZ = 400_000;    // com compressão (texto base64, só ASCII)
const MAX_BATCH_BYTES = 3_000_000; // o Firestore aceita no máx. 10 MiB por gravação em lote

// --- compressão gzip (nos navegadores atuais; senão grava sem comprimir) ---
const canGzip = () => typeof CompressionStream === "function" && typeof DecompressionStream === "function";
async function gzipToB64(text) {
  const buf = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  const u8 = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
async function gunzipFromB64(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

function splitText(text, size = CHUNK_RAW) {
  const parts = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts.length ? parts : [""];
}

/**
 * Salva o objeto completo do BI em uma nova versão.
 * O conteúdo é dividido em documentos para não ultrapassar o limite de 1 MiB.
 */
export async function saveBI(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new TypeError("Os dados do BI devem ser um objeto.");
  }

  const dataTime = Number(data.__t) || Date.now();
  const versionId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const versionRef = doc(db, ROOT, "versions", "items", versionId);
  const chunksRef = collection(versionRef, "chunks");
  const manifest = {};

  const z = canGzip();
  let batch = writeBatch(db);
  let writes = 0;
  let bytes = 0;
  const written = [];
  try {

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || key === "__t") continue;
    const json = JSON.stringify(value);
    const payload = z ? await gzipToB64(json) : json;
    const chunks = splitText(payload, z ? CHUNK_GZ : CHUNK_RAW);
    manifest[key] = chunks.length;

    for (let index = 0; index < chunks.length; index++) {
      const size = chunks[index].length + 200;
      // fecha o lote antes de passar do limite de bytes ou de gravações
      if (writes && (writes >= 400 || bytes + size > MAX_BATCH_BYTES)) {
        await batch.commit();
        batch = writeBatch(db);
        writes = 0;
        bytes = 0;
      }
      const chunkId = `${encodeURIComponent(key)}_${String(index).padStart(5, "0")}`;
      const chunkRef = doc(chunksRef, chunkId);
      batch.set(chunkRef, { key, index, payload: chunks[index] });
      written.push(chunkRef);
      writes++;
      bytes += size;
    }
  }

  if (writes) await batch.commit();

  // Publica a versão só depois que todos os pedaços foram gravados.
  await setDoc(versionRef, {
    manifest,
    savedAt: serverTimestamp(),
    t: dataTime,
    z: z ? 1 : 0,
    formatVersion: 2
  });

  await setDoc(doc(db, ROOT, CURRENT_DOC), {
    versionId,
    t: dataTime,
    savedAt: serverTimestamp()
  });
  } catch (err) {
    // falhou no meio: remove o que já tinha sido gravado (a versão antiga continua valendo)
    try {
      for (let i = 0; i < written.length; i += 400) {
        const b = writeBatch(db);
        written.slice(i, i + 400).forEach(r => b.delete(r));
        await b.commit();
      }
    } catch (_) { /* melhor esforço */ }
    throw err;
  }

  pruneOldVersions(versionId); // limpeza em segundo plano; não bloqueia o salvamento
  return { versionId };
}

/** Apaga versões antigas (e seus pedaços) para não acumular dados no Firestore. */
async function pruneOldVersions(keepId) {
  try {
    const versions = await getDocs(collection(db, ROOT, "versions", "items"));
    for (const v of versions.docs) {
      if (v.id === keepId) continue;
      // preserva versões muito recentes (podem estar sendo gravadas por outro aparelho)
      if (Number(v.id.split("_")[0]) > Date.now() - 120000) continue;
      const chunks = await getDocs(collection(v.ref, "chunks"));
      let batch = writeBatch(db), n = 0;
      for (const c of chunks.docs) {
        batch.delete(c.ref);
        if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); }
      }
      batch.delete(v.ref);
      await batch.commit();
    }
  } catch (e) {
    console.warn("Limpeza de versões antigas não concluída:", e);
  }
}

/** Carrega a versão apontada como atual. Retorna null se ainda não houver dados salvos. */
export async function loadBI() {
  const currentSnap = await getDoc(doc(db, ROOT, CURRENT_DOC));
  if (!currentSnap.exists()) return null;

  const { versionId } = currentSnap.data();
  if (!versionId) return null;

  const versionRef = doc(db, ROOT, "versions", "items", versionId);
  const versionSnap = await getDoc(versionRef);
  if (!versionSnap.exists()) {
    throw new Error("A versão atual foi referenciada, mas não foi encontrada.");
  }

  const { manifest, z, t } = versionSnap.data();
  const chunkSnap = await getDocs(collection(versionRef, "chunks"));
  const byKey = new Map();

  chunkSnap.forEach(snap => {
    const item = snap.data();
    if (!byKey.has(item.key)) byKey.set(item.key, []);
    byKey.get(item.key)[item.index] = item.payload;
  });

  const result = {};
  for (const [key, count] of Object.entries(manifest || {})) {
    const parts = byKey.get(key) || [];
    if (parts.length < count || parts.slice(0, count).some(part => typeof part !== "string")) {
      throw new Error(`Dados incompletos no Firebase para "${key}".`);
    }
    const joined = parts.slice(0, count).join("");
    result[key] = JSON.parse(z ? await gunzipFromB64(joined) : joined);
  }

  return { data: result, versionId, t: Number(t) || Number(currentSnap.data().t) || 1 };
}

/** Lê só o ponteiro da versão atual (leve): { t, versionId } ou null. */
export async function getCurrentMeta() {
  const snap = await getDoc(doc(db, ROOT, CURRENT_DOC));
  if (!snap.exists()) return null;
  const d = snap.data();
  return { t: Number(d.t) || 1, versionId: d.versionId };
}

/** Avisa em tempo real quando outro aparelho publica uma versão nova. Retorna a função para cancelar. */
export function onCurrentChange(callback, onError) {
  return onSnapshot(doc(db, ROOT, CURRENT_DOC), snap => {
    if (!snap.exists()) return callback(null);
    const d = snap.data();
    callback({ t: Number(d.t) || 1, versionId: d.versionId });
  }, err => onError && onError(err));
}

// API global usada pelo BI_Embalagens.html.
window.FirebaseBI = { saveBI, loadBI, getCurrentMeta, onCurrentChange };

/* ===================================================================================
 * Ponte window.CLOUD  ↔  BI_Embalagens.html (window.ESP)
 * - Cadastros (clientes/embalagens/inventários) e os últimos relatórios importados
 *   (Embalagem Padrão, Gestão, CE0302) são gravados no Firestore automaticamente.
 * - Vale sempre a versão mais recente (comparando o carimbo de tempo `t`).
 * - Outros aparelhos recebem a atualização em tempo real.
 * =================================================================================== */
const E = () => window.ESP;
const C = () => window.ESP.cs;
const errMsg = e => (e && ((e.code ? e.code + ": " : "") + (e.message || e))) || "erro";
function setState(st, msg = "") { C().st = st; C().msg = msg; E().ui(); }

let started = false, chain = Promise.resolve(), unsub = null, retryTimer = 0, lastVisCheck = 0;

// Executa uma tarefa por vez (evita dois envios/recebimentos simultâneos).
function run(fn) {
  chain = chain.then(fn).catch(e => {
    console.error("Nuvem:", e);
    setState("err", errMsg(e));
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => run(reconcile), 60000); // tenta de novo em 1 min
  });
  return chain;
}

async function doPush() {
  const snap = E().snap();
  if (!(snap.__t > 0)) return;
  setState("sync");
  await saveBI(snap);
  C().known = C().t = snap.__t;
  await E().saveKnown();
}

async function doPull() {
  setState("sync");
  const res = await loadBI();
  if (!res) return;
  await E().apply({ raw: res.data, t: res.t });
  C().known = C().t = res.t;
  await E().saveKnown();
  E().toast("Dados atualizados a partir da nuvem");
}

// Compara este aparelho com a nuvem e envia ou recebe, conforme quem for mais recente.
async function reconcile() {
  const meta = await getCurrentMeta();
  const local = E().t();
  if (!meta) {                       // nuvem vazia
    C().t = 0;
    if (local > 0 && E().hasData()) await doPush();
  } else if (meta.t > local) {       // nuvem mais nova → recebe
    C().t = meta.t;
    await doPull();
  } else if (local > meta.t) {       // este aparelho mais novo → envia
    await doPush();
  } else {                           // iguais
    C().t = C().known = meta.t;
    await E().saveKnown();
  }
  setState("ok");
}

function listen() {
  if (unsub) return;
  unsub = onCurrentChange(m => {
    if (!m || m.t <= E().t()) return; // nada novo (inclui o eco do nosso próprio envio)
    run(reconcile);
  }, e => setState("err", errMsg(e)));
}

window.CLOUD = {
  async start() {
    if (started) return;
    if (!window.ESP) { setTimeout(() => window.CLOUD.start(), 200); return; }
    started = true;
    setState("conn");
    try { C().known = await E().loadKnown(); } catch (_) { C().known = 0; }
    await run(reconcile);
    listen();
  },
  push() { return run(reconcile); },   // chamado pelo BI 3 s após cada alteração
  sync() { return run(reconcile); }    // botão "Sincronizar"
};

window.addEventListener("online", () => started && run(reconcile));
document.addEventListener("visibilitychange", () => {
  if (!started) return;
  if (document.visibilityState === "hidden") {
    if (E().t() > C().known) run(reconcile);              // salva antes de o app ir ao fundo
  } else if (Date.now() - lastVisCheck > 15000) {
    lastVisCheck = Date.now();
    run(reconcile);                                       // ao voltar, confere se há novidades
  }
});

// O BI marca __cloudGo quando termina de carregar; se já passou, inicia agora.
if (window.__cloudGo) window.CLOUD.start();
