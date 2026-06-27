const admin   = require('firebase-admin');
const express = require('express');
const webpush = require('web-push');
const app     = express();
const PORT    = process.env.PORT || 3000;

// ── VAPID ─────────────────────────────────────────────────────────────────────
webpush.setVapidDetails(
  'mailto:info@wagenwerks.co',
  'BGJbJk-GDB628zrd0lmDKL9OA5BwvdhGbr37KolTO7BKGf8N_mzpVv01AePamXyL0ydQ1IC8zbzaZ06dm-qkoaI',
  'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgnLsQqkFow19Xv-LRqKA0XaK5J3BnMOfJl54Hrwso4dOhRANCAARiWyZPhgwetvM63dJZgyi_TgOQcL3YRm69-yqJUzuwShn_Df5s6Vb9NQHj2pl8i9MnUNSAvM282mdOnZvqpKGi'
);

// ── Firebase Admin ────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://wagen-werks-default-rtdb.firebaseio.com'
});
const db = admin.database();
const ROOT = 'wagenwerks';
console.log('[WW] Servidor iniciado');

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getAdminSubs() {
  const snap = await db.ref(ROOT+'/push-subs/admin').get();
  if(!snap.exists()) return [];
  return Object.values(snap.val()).filter(s => s && s.endpoint);
}

async function getClientSub(vehicleId) {
  const snap = await db.ref(ROOT+'/push-subs/clients/'+vehicleId).get();
  if(!snap.exists()) return null;
  return snap.val();
}

async function sendPush(subs, title, body, tag) {
  const arr = Array.isArray(subs) ? subs : [subs];
  const payload = JSON.stringify({title, body, tag: tag||'ww'});
  for(const sub of arr.filter(Boolean)){
    try{
      await webpush.sendNotification(sub, payload);
      console.log('[WW] Push enviado a', sub.endpoint.slice(-20));
    }catch(e){
      console.error('[WW] Error push:', e.statusCode, e.message);
      if(e.statusCode===410||e.statusCode===404){
        // Suscripción expirada — borrar de Firebase
        await db.ref(ROOT+'/push-subs').transaction(d=>{
          if(!d) return d;
          ['admin','clients'].forEach(k=>{
            if(d[k]) Object.keys(d[k]).forEach(id=>{
              if(d[k][id]&&d[k][id].endpoint===sub.endpoint) delete d[k][id];
            });
          });
          return d;
        });
      }
    }
  }
}

// ── Listener ──────────────────────────────────────────────────────────────────
const seen = new Set();

db.ref(ROOT).on('child_changed', async (snap) => {
  const key = snap.key;
  if(!key||!key.startsWith('ww-vehicle-')) return;
  const v = snap.val(); if(!v) return;
  const vId = v.id||key.replace('ww-vehicle-','');

  // Cotización aprobada → notificar taller
  const cotKey = 'cot-'+vId;
  if(v.cotizacion&&(v.cotizacion.estado==='aprobada_total'||v.cotizacion.estado==='aprobada_parcial')&&!seen.has(cotKey)){
    seen.add(cotKey); setTimeout(()=>seen.delete(cotKey), 60000);
    console.log('[WW] Cotización aprobada:', v.placa);
    const subs = await getAdminSubs();
    await sendPush(subs, '✅ Cotización aprobada — '+v.placa, (v.cliente_nombre||'El cliente')+' aprobó la cotización.', cotKey);
  }

  // Vehículo listo → notificar cliente
  const listoKey = 'listo-'+vId;
  if((v.estado_general==='listo'||v.estado_general==='entregado')&&!seen.has(listoKey)){
    seen.add(listoKey); setTimeout(()=>seen.delete(listoKey), 300000);
    console.log('[WW] Vehículo listo:', v.placa);
    const sub = await getClientSub(vId);
    if(sub) await sendPush([sub], '🏁 Tu vehículo está listo — Wagen Werks', v.placa+' está listo para recoger. Cra 46 # 138-68, Bogotá.', listoKey);
  }
});

// ── Keep-alive ────────────────────────────────────────────────────────────────
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if(SELF_URL){
  const fetch = require('node-fetch');
  setInterval(()=>fetch(SELF_URL+'/ping').catch(()=>{}), 13*60*1000);
}

app.get('/',     (req,res)=>res.send('WagenWerks Push Server — OK'));
app.get('/ping', (req,res)=>res.send('pong'));
app.listen(PORT, ()=>console.log('[WW] Puerto '+PORT));
