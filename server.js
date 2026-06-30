const admin   = require('firebase-admin');
const express = require('express');
const webpush = require('web-push');
const app     = express();
const PORT    = process.env.PORT || 3000;

webpush.setVapidDetails(
  'mailto:info@wagenwerks.co',
  'BLjkKw8whc_0QLcsfwFEtgwjpM5JteTfjfpeP5FyHbNjosJvNL7Y3QuRYMBfUYPOh0mYi259JcXJIpT4TjxYkZk',
  '5pUSVhqE0XJWnmsKDCe1vkeCK3tN2Bk4zTeBeiiu_dg'
);

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://wagen-werks-default-rtdb.firebaseio.com'
});
const db = admin.database();
const ROOT = 'wagenwerks';
console.log('[WW] Servidor iniciado — escuchando Firebase');

async function getAdminSubs() {
  const snap = await db.ref(ROOT+'/push-subs/admin').get();
  if(!snap.exists()){ console.log('[WW] Sin suscripciones admin'); return []; }
  const subs = Object.values(snap.val()).filter(s => s && s.endpoint);
  console.log('[WW] Suscripciones admin encontradas:', subs.length);
  return subs;
}

async function getClientSub(vehicleId) {
  const snap = await db.ref(ROOT+'/push-subs/clients/'+vehicleId).get();
  if(!snap.exists()) return null;
  return snap.val();
}

async function sendPush(subs, title, body, tag) {
  const arr = Array.isArray(subs) ? subs : [subs];
  const payload = JSON.stringify({title, body, tag: tag||'ww'});
  console.log('[WW] Enviando push a', arr.length, 'suscripciones — "'+title+'"');
  for(const sub of arr.filter(Boolean)){
    try{
      await webpush.sendNotification(sub, payload);
      console.log('[WW] ✓ Push enviado OK a', sub.endpoint.slice(-30));
    }catch(e){
      console.error('[WW] ✗ Error push:', e.statusCode, e.message);
      // Limpiar suscripción expirada
      if(e.statusCode===410||e.statusCode===404){
        console.log('[WW] Suscripción expirada — borrando');
        const ref = db.ref(ROOT+'/push-subs');
        const all = (await ref.get()).val()||{};
        for(const grp of Object.keys(all)){
          for(const id of Object.keys(all[grp]||{})){
            if(all[grp][id]&&all[grp][id].endpoint===sub.endpoint){
              await ref.child(grp+'/'+id).remove();
            }
          }
        }
      }
    }
  }
}

const seenCot   = new Set();
const seenListo = new Set();

db.ref(ROOT).on('child_changed', async (snap) => {
  const key = snap.key;
  if(!key||!key.startsWith('ww-vehicle-')) return;
  const v = snap.val(); if(!v) return;
  const vId = v.id||key.replace('ww-vehicle-','');
  console.log('[WW] Cambio detectado en:', key, '| estado:', v.estado_general, '| cot:', v.cotizacion&&v.cotizacion.estado);

  // ── Cotización aprobada → notificar TALLER ─────────────────────────────────
  const cotEstado = v.cotizacion && v.cotizacion.estado;
  if((cotEstado==='aprobada_total'||cotEstado==='aprobada_parcial') && !seenCot.has(vId)){
    seenCot.add(vId);
    setTimeout(()=>seenCot.delete(vId), 120000);
    console.log('[WW] → Cotización aprobada:', v.placa);
    const subs = await getAdminSubs();
    if(subs.length){
      await sendPush(subs,
        '✅ Cotización aprobada — '+(v.placa||''),
        (v.cliente_nombre||'El cliente')+' aprobó la cotización desde el portal.',
        'cot-'+vId
      );
    }
  }

  // ── Vehículo LISTO → notificar CLIENTE (solo en 'listo', no en 'entregado') ─
  if(v.estado_general==='listo' && !seenListo.has(vId)){
    seenListo.add(vId);
    // No borrar del set — así 'entregado' posterior no renotifica
    console.log('[WW] → Vehículo listo:', v.placa);
    const sub = await getClientSub(vId);
    if(sub){
      await sendPush([sub],
        '🏁 Tu vehículo está listo — Wagen Werks',
        (v.placa||'')+' está listo para recoger. Cra 46 # 138-68, Bogotá.',
        'listo-'+vId
      );
    } else {
      console.log('[WW] Sin suscripción cliente para vehículo', vId);
    }
  }
});

db.ref(ROOT).on('child_added', (snap)=>{
  // Ignorar silenciosamente — solo necesitamos child_changed
});

// Keep-alive
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if(SELF_URL){
  const fetch = require('node-fetch');
  setInterval(()=>fetch(SELF_URL+'/ping').catch(()=>{}), 13*60*1000);
  console.log('[WW] Keep-alive activo →', SELF_URL);
}

app.get('/',     (req,res)=>res.send('WagenWerks Push Server — OK'));
app.get('/ping', (req,res)=>res.send('pong'));
app.listen(PORT, ()=>console.log('[WW] Puerto', PORT));
