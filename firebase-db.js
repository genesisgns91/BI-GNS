// Firebase Cloud Database para o Espelho SMA (acesso direto pelo link, SEM login)
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

const ROOT = "espelhoSMA";
const CURRENT_DOC = "current";
const CHUNK_SIZE = 150_000; // margem segura abaixo do limite de 1 MiB/documento

function splitText(text, size = CHUNK_SIZE) {
  const parts = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts.length ? parts : [""];
}

/**
 * Salva o objeto completo do Espelho em uma nova versão.
 * O conteúdo é dividido em documentos para não ultrapassar o limite de 1 MiB.
 */
export async function saveEspelho(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new TypeError("Os dados do Espelho devem ser um objeto.");
  }

  const dataTime = Number(data.__t) || Date.now();
  const versionId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const versionRef = doc(db, ROOT, "versions", "items", versionId);
  const chunksRef = collection(versionRef, "chunks");
  const manifest = {};

  let batch = writeBatch(db);
  let writes = 0;

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const json = JSON.stringify(value);
    const chunks = splitText(json);
    manifest[key] = chunks.length;

    for (let index = 0; index < chunks.length; index++) {
      const chunkId = `${encodeURIComponent(key)}_${String(index).padStart(5, "0")}`;
      batch.set(doc(chunksRef, chunkId), { key, index, payload: chunks[index] });
      writes++;

      if (writes >= 400) {
        await batch.commit();
        batch = writeBatch(db);
        writes = 0;
      }
    }
  }

  if (writes) await batch.commit();

  // Publica a versão só depois que todos os pedaços foram gravados.
  await setDoc(versionRef, {
    manifest,
    savedAt: serverTimestamp(),
    t: dataTime,
    formatVersion: 1
  });

  await setDoc(doc(db, ROOT, CURRENT_DOC), {
    versionId,
    t: dataTime,
    savedAt: serverTimestamp()
  });

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
export async function loadEspelho() {
  const currentSnap = await getDoc(doc(db, ROOT, CURRENT_DOC));
  if (!currentSnap.exists()) return null;

  const { versionId } = currentSnap.data();
  if (!versionId) return null;

  const versionRef = doc(db, ROOT, "versions", "items", versionId);
  const versionSnap = await getDoc(versionRef);
  if (!versionSnap.exists()) {
    throw new Error("A versão atual foi referenciada, mas não foi encontrada.");
  }

  const { manifest } = versionSnap.data();
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
    result[key] = JSON.parse(parts.slice(0, count).join(""));
  }

  return { data: result, versionId };
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

// API global usada pelo HTML do Espelho.
window.FirebaseDB = { saveEspelho, loadEspelho, getCurrentMeta, onCurrentChange };
