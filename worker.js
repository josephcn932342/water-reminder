const json = (data, init = {}) => new Response(JSON.stringify(data), {
  ...init,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(init.headers || {})
  }
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        service: 'water-reminder',
        timezone: 'Asia/Taipei'
      });
    }

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')) {
      return json({
        ok: false,
        message: '提醒後台正在設定中'
      }, { status: 503 });
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller, _env, _ctx) {
    // 每分鐘喚醒一次；下一階段會在此讀取台灣時間的提醒設定並發送推播。
  }
};
