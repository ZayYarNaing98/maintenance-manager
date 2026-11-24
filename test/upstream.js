export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/redirect') return Response.redirect(new URL('/destination', url), 302);
    return Response.json({
      hostname: url.hostname,
      path: url.pathname + url.search,
      authorization: request.headers.get('Authorization'),
      body: request.method === 'POST' ? await request.text() : null,
    });
  },
};
