import webpush from 'web-push';

const DEFAULT_CONFIG = {
  enabled: true,
  timezone: 'Asia/Taipei',
  days: [1, 2, 3, 4, 5],
  times: ['09:30', '11:00', '14:00', '15:30', '17:00']
};

const PHRASES = [
  ['喝水~', '忙完這一小段，記得喝一口水 ♡'],
  ['補水啦', '休息一下，喝口水再繼續吧'],
  ['喝一口', '今天也要好好照顧自己 ♡'],
  ['潤潤喉', '小小喝一口就好']
];

const json = (data, init = {}) => new Response(JSON.stringify(data), {
  ...init,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(init.headers || {})
  }
});

const unauthorized = () => json({ ok: false, message: '密碼不正確' }, { status: 401 });

function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  return request.headers.get('authorization') === `Bearer ${env.ADMIN_PASSWORD}`;
}

function isPhotoAdmin(request, env) {
  const password = request.headers.get('authorization');
  return Boolean(password) && (
    (env.PHOTO_PASSWORD && password === `Bearer ${env.PHOTO_PASSWORD}`) ||
    (env.ADMIN_PASSWORD && password === `Bearer ${env.ADMIN_PASSWORD}`)
  );
}

async function getGallery(env) {
  const listed = await env.REMINDER_KV.list({ prefix: 'gallery:photo:' });
  const photos = (await Promise.all(listed.keys.map(({ name }) => env.REMINDER_KV.get(name, 'json')))).filter(Boolean);
  const order = await env.REMINDER_KV.get('gallery:order', 'json') || [];
  const rank = new Map(order.map((id, index) => [id, index]));
  return photos.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.createdAt.localeCompare(b.createdAt));
}

function safePosition(value) {
  return /^(25|50|75)% (20|35|50|65|80)%$/.test(value || '') ? value : '50% 50%';
}

function validSubscription(value) {
  return value && typeof value.endpoint === 'string' &&
    value.keys && typeof value.keys.p256dh === 'string' && typeof value.keys.auth === 'string';
}

async function subscriptionKey(endpoint) {
  const bytes = new TextEncoder().encode(endpoint);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `subscription:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function getConfig(env) {
  return await env.REMINDER_KV.get('config', 'json') || DEFAULT_CONFIG;
}

function normalizeConfig(input) {
  const times = Array.isArray(input.times)
    ? [...new Set(input.times.filter((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)))].sort()
    : [];
  const days = Array.isArray(input.days)
    ? [...new Set(input.days.map(Number).filter((day) => day >= 0 && day <= 6))]
    : [];
  return {
    enabled: input.enabled !== false,
    timezone: 'Asia/Taipei',
    days,
    times
  };
}

function taipeiClock(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).reduce((all, part) => ({ ...all, [part.type]: part.value }), {});
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
  return {
    weekday,
    time: `${parts.hour}:${parts.minute}`,
    date: `${parts.year}-${parts.month}-${parts.day}`
  };
}

async function sendPushes(env, customMessage) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    throw new Error('VAPID 尚未設定');
  }

  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const chosen = PHRASES[Math.floor(Math.random() * PHRASES.length)];
  const payload = JSON.stringify({
    title: customMessage?.title || chosen[0],
    body: customMessage?.body || chosen[1],
    url: './?from=push'
  });
  const keys = await env.REMINDER_KV.list({ prefix: 'subscription:' });
  let sent = 0;

  await Promise.all(keys.keys.map(async ({ name }) => {
    const subscription = await env.REMINDER_KV.get(name, 'json');
    if (!validSubscription(subscription)) return;
    try {
      await webpush.sendNotification(subscription, payload);
      sent += 1;
    } catch (error) {
      if (error?.statusCode === 404 || error?.statusCode === 410) await env.REMINDER_KV.delete(name);
      else console.error('Push failed', error);
    }
  }));

  return { sent, registered: keys.keys.length };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return json({ ok: true, service: 'water-reminder', timezone: 'Asia/Taipei', kv: Boolean(env.REMINDER_KV) });
    }

    if (url.pathname === '/api/public-key' && request.method === 'GET') {
      if (!env.VAPID_PUBLIC_KEY) return json({ ok: false, message: '推播金鑰尚未設定' }, { status: 503 });
      return json({ ok: true, publicKey: env.VAPID_PUBLIC_KEY });
    }

    if (url.pathname === '/api/photos' && request.method === 'GET') {
      const photos = (await getGallery(env))
        .filter((photo) => photo.enabled)
        .map(({ id, position }) => ({ src: `/media/${id}`, position }));
      return json({ ok: true, photos });
    }

    if (url.pathname.startsWith('/media/') && request.method === 'GET') {
      const id = url.pathname.slice('/media/'.length);
      if (!/^[0-9a-f-]{36}$/.test(id)) return new Response('Not found', { status: 404 });
      const object = await env.REMINDER_KV.getWithMetadata(`photo:${id}`, 'arrayBuffer');
      if (!object.value) return new Response('Not found', { status: 404 });
      const headers = new Headers({ 'content-type': object.metadata?.contentType || 'image/jpeg' });
      headers.set('cache-control', 'public, max-age=86400');
      return new Response(object.value, { headers });
    }

    if (url.pathname === '/api/gallery' && request.method === 'GET') {
      if (!isPhotoAdmin(request, env)) return unauthorized();
      return json({ ok: true, photos: await getGallery(env) });
    }

    if (url.pathname === '/api/gallery/upload' && request.method === 'POST') {
      if (!isPhotoAdmin(request, env)) return unauthorized();
      const type = request.headers.get('content-type') || '';
      const size = Number(request.headers.get('content-length') || 0);
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) {
        return json({ ok: false, message: '只支援 JPG、PNG 或 WebP' }, { status: 415 });
      }
      if (size > 12 * 1024 * 1024) return json({ ok: false, message: '單張圖片不能超過 12 MB' }, { status: 413 });
      const id = crypto.randomUUID();
      const name = decodeURIComponent(request.headers.get('x-file-name') || 'photo');
      const body = await request.arrayBuffer();
      if (!body.byteLength || body.byteLength > 12 * 1024 * 1024) {
        return json({ ok: false, message: '圖片大小不正確' }, { status: 400 });
      }
      const photo = { id, name: name.slice(0, 120), type, size: body.byteLength, enabled: true, position: '50% 50%', createdAt: new Date().toISOString() };
      await env.REMINDER_KV.put(`photo:${id}`, body, { metadata: { contentType: type } });
      await env.REMINDER_KV.put(`gallery:photo:${id}`, JSON.stringify(photo));
      return json({ ok: true, photo });
    }

    if (url.pathname.startsWith('/api/gallery/') && request.method === 'PATCH') {
      if (!isPhotoAdmin(request, env)) return unauthorized();
      const id = url.pathname.slice('/api/gallery/'.length);
      const change = await request.json().catch(() => ({}));
      const photos = await getGallery(env);
      const photo = photos.find((item) => item.id === id);
      if (!photo) return json({ ok: false, message: '找不到圖片' }, { status: 404 });
      if (typeof change.enabled === 'boolean') photo.enabled = change.enabled;
      if (change.position) photo.position = safePosition(change.position);
      await env.REMINDER_KV.put(`gallery:photo:${id}`, JSON.stringify(photo));
      return json({ ok: true, photo });
    }

    if (url.pathname.startsWith('/api/gallery/') && request.method === 'DELETE') {
      if (!isPhotoAdmin(request, env)) return unauthorized();
      const id = url.pathname.slice('/api/gallery/'.length);
      const photos = await getGallery(env);
      if (!photos.some((item) => item.id === id)) return json({ ok: false, message: '找不到圖片' }, { status: 404 });
      await Promise.all([
        env.REMINDER_KV.delete(`photo:${id}`),
        env.REMINDER_KV.delete(`gallery:photo:${id}`)
      ]);
      return json({ ok: true });
    }

    if (url.pathname === '/api/gallery/order' && request.method === 'PUT') {
      if (!isPhotoAdmin(request, env)) return unauthorized();
      const { ids = [] } = await request.json().catch(() => ({}));
      const photos = await getGallery(env);
      const validIds = new Set(photos.map((photo) => photo.id));
      const orderedIds = ids.filter((id) => validIds.has(id));
      photos.forEach((photo) => { if (!orderedIds.includes(photo.id)) orderedIds.push(photo.id); });
      await env.REMINDER_KV.put('gallery:order', JSON.stringify(orderedIds));
      const byId = new Map(photos.map((photo) => [photo.id, photo]));
      return json({ ok: true, photos: orderedIds.map((id) => byId.get(id)).filter(Boolean) });
    }

    if (url.pathname === '/api/subscribe' && request.method === 'POST') {
      const subscription = await request.json().catch(() => null);
      if (!validSubscription(subscription)) return json({ ok: false, message: '訂閱資料不完整' }, { status: 400 });
      await env.REMINDER_KV.put(await subscriptionKey(subscription.endpoint), JSON.stringify(subscription));
      return json({ ok: true });
    }

    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      return env.ASSETS.fetch(new Request(new URL('/admin.html', request.url), request));
    }

    if (url.pathname === '/api/admin/config' && request.method === 'GET') {
      if (!isAdmin(request, env)) return unauthorized();
      const subscriptions = await env.REMINDER_KV.list({ prefix: 'subscription:' });
      return json({ ok: true, config: await getConfig(env), devices: subscriptions.keys.length });
    }

    if (url.pathname === '/api/admin/config' && request.method === 'PUT') {
      if (!isAdmin(request, env)) return unauthorized();
      const config = normalizeConfig(await request.json().catch(() => ({})));
      if (!config.days.length || !config.times.length) {
        return json({ ok: false, message: '至少選一天與一個提醒時間' }, { status: 400 });
      }
      await env.REMINDER_KV.put('config', JSON.stringify(config));
      return json({ ok: true, config });
    }

    if (url.pathname === '/api/admin/test' && request.method === 'POST') {
      if (!isAdmin(request, env)) return unauthorized();
      try { return json({ ok: true, ...(await sendPushes(env, { title: '喝水~', body: '這是一則測試提醒 ♡' })) }); }
      catch (error) { return json({ ok: false, message: error.message }, { status: 503 }); }
    }

    if (url.pathname.startsWith('/api/')) return json({ ok: false, message: '找不到功能' }, { status: 404 });
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env) {
    const config = await getConfig(env);
    if (!config.enabled) return;
    const now = taipeiClock(new Date(controller.scheduledTime));
    if (!config.days.includes(now.weekday) || !config.times.includes(now.time)) return;
    const marker = `sent:${now.date}:${now.time}`;
    if (await env.REMINDER_KV.get(marker)) return;
    await env.REMINDER_KV.put(marker, '1', { expirationTtl: 172800 });
    await sendPushes(env);
  }
};
