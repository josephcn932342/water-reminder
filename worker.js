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
