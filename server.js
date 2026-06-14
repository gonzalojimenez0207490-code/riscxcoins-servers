const express = require('express');
const crypto  = require('crypto');
const axios   = require('axios');
const app     = express();
const PORT    = process.env.PORT || 3000;

// ─── ENV VARS (se configuran en Railway) ─────────────────────
const TWITCH_CLIENT_ID     = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TWITCH_WEBHOOK_SECRET= process.env.TWITCH_WEBHOOK_SECRET || 'risxwebhooksecret';
const FIREBASE_PROJECT     = process.env.FIREBASE_PROJECT || 'risxcoins';
const FIREBASE_API_KEY     = process.env.FIREBASE_API_KEY;
const PUBLIC_URL           = process.env.PUBLIC_URL; // URL de Railway

// ─── FIREBASE REST ────────────────────────────────────────────
const FS_BASE   = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const AUTH_BASE = 'https://identitytoolkit.googleapis.com/v1';

async function getServiceAccountToken() {
  // Usamos la API key para operaciones sin auth de usuario
  // Para operaciones admin necesitamos el service account
  // Por simplicidad usamos la REST API con apiKey para leer/escribir
  return null; // Las reglas de Firestore permiten escritura autenticada
}

async function fsGetWithApiKey(path) {
  try {
    const r = await axios.get(`${FS_BASE}/${path}?key=${FIREBASE_API_KEY}`);
    return firestoreToObj(r.data.fields);
  } catch { return null; }
}

async function fsSetWithApiKey(path, obj) {
  await axios.patch(`${FS_BASE}/${path}?key=${FIREBASE_API_KEY}`, {
    fields: objToFirestore(obj)
  });
}

async function fsUpdateWithApiKey(path, obj) {
  const params = Object.keys(obj).map(k => `updateMask.fieldPaths=${k}`).join('&');
  await axios.patch(`${FS_BASE}/${path}?${params}&key=${FIREBASE_API_KEY}`, {
    fields: objToFirestore(obj)
  });
}

async function fsQueryByField(collection, field, value) {
  try {
    const r = await axios.post(
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents:runQuery?key=${FIREBASE_API_KEY}`,
      {
        structuredQuery: {
          from: [{ collectionId: collection }],
          where: {
            fieldFilter: {
              field: { fieldPath: field },
              op: 'EQUAL',
              value: { stringValue: value }
            }
          },
          limit: 1
        }
      }
    );
    const docs = r.data.filter(d => d.document);
    if (!docs.length) return null;
    const doc = docs[0].document;
    const id = doc.name.split('/').pop();
    return { id, ...firestoreToObj(doc.fields) };
  } catch (e) {
    console.error('Query error:', e.response?.data || e.message);
    return null;
  }
}

function objToFirestore(obj) {
  const f = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') f[k] = { stringValue: v };
    else if (typeof v === 'number') f[k] = { integerValue: String(v) };
    else if (typeof v === 'boolean') f[k] = { booleanValue: v };
    else f[k] = { nullValue: null };
  }
  return f;
}

function firestoreToObj(fields) {
  if (!fields) return null;
  const o = {};
  for (const [k, v] of Object.entries(fields)) {
    if ('stringValue' in v) o[k] = v.stringValue;
    else if ('integerValue' in v) o[k] = parseInt(v.integerValue);
    else if ('doubleValue' in v) o[k] = v.doubleValue;
    else if ('booleanValue' in v) o[k] = v.booleanValue;
    else o[k] = null;
  }
  return o;
}

// ─── TWITCH APP TOKEN ─────────────────────────────────────────
let appToken = null;
let appTokenExpiry = 0;

async function getTwitchAppToken() {
  if (appToken && Date.now() < appTokenExpiry) return appToken;
  const r = await axios.post('https://id.twitch.tv/oauth2/token', null, {
    params: {
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials'
    }
  });
  appToken = r.data.access_token;
  appTokenExpiry = Date.now() + (r.data.expires_in - 60) * 1000;
  return appToken;
}

// ─── WEBHOOK TWITCH EVENTSUB ──────────────────────────────────
app.post('/webhooks/twitch', express.raw({ type: 'application/json' }), async (req, res) => {
  const msgId   = req.headers['twitch-eventsub-message-id'];
  const ts      = req.headers['twitch-eventsub-message-timestamp'];
  const sig     = req.headers['twitch-eventsub-message-signature'];
  const msgType = req.headers['twitch-eventsub-message-type'];

  // Verificar firma
  const hmac = 'sha256=' + crypto
    .createHmac('sha256', TWITCH_WEBHOOK_SECRET)
    .update(msgId + ts + req.body)
    .digest('hex');

  if (hmac !== sig) {
    console.log('❌ Firma inválida');
    return res.status(403).send('Forbidden');
  }

  const body = JSON.parse(req.body);

  // Verificación inicial de Twitch
  if (msgType === 'webhook_callback_verification') {
    console.log('✅ Webhook verificado por Twitch');
    return res.status(200).send(body.challenge);
  }

  // Notificación de canje de puntos
  if (msgType === 'notification') {
    const event = body.event;
    const twitchUserId = event.user_id;
    const twitchLogin  = event.user_login;
    const rewardTitle  = event.reward.title;
    const redemptionId = event.id;

    console.log(`🎮 Canje: ${twitchLogin} → "${rewardTitle}"`);

    // La recompensa debe llamarse "RisxCoins XXXX" donde XXXX es la cantidad de puntos
    const match = rewardTitle.match(/risxcoins[:\s]*(\d+)/i);
    if (match) {
      const twitchPoints = parseInt(match[1]);
      const coinsToAdd   = Math.floor(twitchPoints / 1000) * 10;

      if (coinsToAdd > 0) {
        try {
          // Buscar usuario por twitch_id en Firebase
          const user = await fsQueryByField('users', 'twitch_id', twitchUserId);

          if (user) {
            // Verificar que no se haya procesado ya
            const alreadyDone = await fsGetWithApiKey(`users/${user.id}/transactions/${redemptionId}`);
            if (!alreadyDone) {
              const newCoins = (user.coins || 0) + coinsToAdd;
              await fsUpdateWithApiKey(`users/${user.id}`, { coins: newCoins });
              await fsSetWithApiKey(`users/${user.id}/transactions/${redemptionId}`, {
                type: 'earn',
                amount: coinsToAdd,
                twitchPoints,
                description: `Canje automático: ${twitchPoints.toLocaleString()} puntos del canal`,
                createdAt: new Date().toISOString()
              });
              console.log(`✅ +${coinsToAdd} RisxCoins para ${twitchLogin} (${newCoins} total)`);
            } else {
              console.log(`⚠️ Canje ${redemptionId} ya procesado`);
            }
          } else {
            console.log(`⚠️ ${twitchLogin} no tiene cuenta RisxCoins vinculada`);
            // Guardar canje pendiente para cuando se registre
            await fsSetWithApiKey(`pending_redemptions/${redemptionId}`, {
              twitchUserId,
              twitchLogin,
              twitchPoints,
              coinsToAdd,
              createdAt: new Date().toISOString()
            });
          }
        } catch (e) {
          console.error('Error procesando canje:', e.message);
        }
      }
    }
  }

  res.status(200).send('ok');
});

// ─── SETUP EVENTSUB (llamar una vez desde el navegador) ───────
app.get('/setup', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  try {
    const token = await getTwitchAppToken();

    // Obtener broadcaster_id de risx00
    const userRes = await axios.get('https://api.twitch.tv/helix/users', {
      params: { login: 'risx00' },
      headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID }
    });
    const broadcasterId = userRes.data.data[0].id;
    console.log('Broadcaster ID risx00:', broadcasterId);

    // Suscribirse a channel.channel_points_custom_reward_redemption.add
    const subRes = await axios.post('https://api.twitch.tv/helix/eventsub/subscriptions', {
      type: 'channel.channel_points_custom_reward_redemption.add',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId },
      transport: {
        method: 'webhook',
        callback: `${PUBLIC_URL}/webhooks/twitch`,
        secret: TWITCH_WEBHOOK_SECRET
      }
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Client-Id': TWITCH_CLIENT_ID,
        'Content-Type': 'application/json'
      }
    });

    res.json({ ok: true, subscription: subRes.data.data[0], broadcasterId });
  } catch (e) {
    console.error('Setup error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// ─── ENDPOINT: vincular Twitch a cuenta RisxCoins ─────────────
app.get('/link-twitch', async (req, res) => {
  const { userId, twitchId, twitchLogin } = req.query;
  if (!userId || !twitchId) return res.status(400).json({ error: 'Faltan parámetros' });

  try {
    await fsUpdateWithApiKey(`users/${userId}`, { twitch_id: twitchId, twitch_login: twitchLogin });

    // Procesar canjes pendientes de este usuario
    const pending = await fsQueryByField('pending_redemptions', 'twitchUserId', twitchId);
    if (pending) {
      const user = await fsGetWithApiKey(`users/${userId}`);
      const newCoins = (user?.coins || 0) + pending.coinsToAdd;
      await fsUpdateWithApiKey(`users/${userId}`, { coins: newCoins });
      console.log(`✅ Canjes pendientes procesados para ${twitchLogin}: +${pending.coinsToAdd}`);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'RisxCoins server running', time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 RisxCoins server on port ${PORT}`);
  console.log(`📡 Webhook: ${PUBLIC_URL}/webhooks/twitch`);
});
