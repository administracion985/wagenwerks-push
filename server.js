const admin   = require('firebase-admin');
const express = require('express');
const app     = express();
const PORT    = process.env.PORT || 3000;

// ── Firebase Admin init ───────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential:  admin.credential.cert(serviceAccount),
  databaseURL: 'https://wagen-werks-default-rtdb.firebaseio.com'
});
const db = admin.database();
const ROOT = 'wagenwerks';
console.log('[WW] Servidor iniciado — conectado a Firebase');

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getAdminTokens() {
  // Obtiene tokens FCM de Luis, Alejandro Díaz y David (acceso a cotización)
  const snap = await db.ref(`${ROOT}/fcm-tokens/admin`).get();
  if (!snap.exists()) return [];
  const data = snap.val();
  return Object.values(data)
    .filter(d => d && d.token)
    .map(d => d.token);
}

async function getClientToken(vehicleId) {
  const snap = await db.ref(`${ROOT}/fcm-tokens/clients/${vehicleId}`).get();
  if (!snap.exists()) return null;
  return snap.val().token || null;
}

async function sendPush(tokens, title, body, tag) {
  const arr = Array.isArray(tokens) ? tokens.filter(Boolean) : [tokens].filter(Boolean);
  if (!arr.length) { console.log('[WW] Sin tokens para enviar'); return; }
  try {
    const res = await admin.messaging().sendEachForMulticast({
      tokens: arr,
      notification: { title, body },
      webpush: {
        notification: { title, body, icon: '/icon-192.png', badge: '/icon-192.png', tag },
        fcmOptions: { link: '/' }
      }
    });
    console.log(`[WW] Push enviado: ${res.successCount} éxito / ${res.failureCount} fallo`);
  } catch(e) {
    console.error('[WW] Error enviando push:', e.message);
  }
}

// ── Listener principal ────────────────────────────────────────────────────────
const seen = new Set(); // evita notificaciones duplicadas

db.ref(ROOT).on('child_changed', async (snap) => {
  const key = snap.key;
  if (!key || !key.startsWith('ww-vehicle-')) return;
  const v = snap.val();
  if (!v) return;

  const vId = v.id || key.replace('ww-vehicle-', '');

  // ── 1. Cliente aprobó cotización ──────────────────────────────────────────
  const cotKey = `cot-aprob-${vId}`;
  if (
    v.cotizacion &&
    (v.cotizacion.estado === 'aprobada_total' || v.cotizacion.estado === 'aprobada_parcial') &&
    !seen.has(cotKey)
  ) {
    seen.add(cotKey);
    setTimeout(() => seen.delete(cotKey), 60000); // reset después de 1 min
    console.log(`[WW] Cotización aprobada: ${v.placa}`);
    const tokens = await getAdminTokens();
    await sendPush(
      tokens,
      `✅ Cotización aprobada — ${v.placa}`,
      `${v.cliente_nombre || 'El cliente'} aprobó la cotización desde el portal.`,
      cotKey
    );
  }

  // ── 2. Vehículo marcado como Listo ────────────────────────────────────────
  const listoKey = `listo-${vId}`;
  if (
    (v.estado_general === 'listo' || v.estado_general === 'entregado') &&
    !seen.has(listoKey)
  ) {
    seen.add(listoKey);
    setTimeout(() => seen.delete(listoKey), 300000); // reset en 5 min
    console.log(`[WW] Vehículo listo: ${v.placa}`);
    const clientToken = await getClientToken(vId);
    if (clientToken) {
      await sendPush(
        [clientToken],
        `🏁 Tu vehículo está listo — Wagen Werks`,
        `${v.placa} (${(v.marca||'')+' '+(v.modelo||'')}.trim()) está listo para recoger. Cra 46 # 138-68, Bogotá.`,
        listoKey
      );
    }
  }
});

// ── Keep-alive (evita que Render duerma el servidor) ─────────────────────────
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  setInterval(() => {
    const fetch = require('node-fetch');
    fetch(SELF_URL + '/ping').catch(() => {});
  }, 13 * 60 * 1000); // cada 13 minutos
}

app.get('/',     (req, res) => res.send('WagenWerks Push Server — OK'));
app.get('/ping', (req, res) => res.send('pong'));
app.listen(PORT, () => console.log(`[WW] Escuchando en puerto ${PORT}`));
