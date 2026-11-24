// A small in-memory stand-in for the Cloudflare API endpoints the manager uses.
const zones = [{ id: 'zone-1', name: 'example.test' }];
const routes = [{ id: 'route-taken', pattern: 'taken.example.test/*', script: 'other-worker' }];
const records = [
  'app.example.test', 'www.app.example.test', 'other.example.test', 'new.example.test',
  'taken.example.test', 'fail.example.test', 'site.example.test', 'cd.example.test',
].map((name, index) => ({ id: `dns-${index}`, name, type: 'A', comment: null }));
// A record the manager did not create, such as one belonging to a Worker custom domain.
records.push({ id: 'dns-custom', name: 'custom-preview.example.test', type: 'AAAA', comment: null });
// Custom domain names that the DNS list hides but that cannot be created again.
const hidden = new Set(['cd-preview.example.test']);
let sequence = 0;

const reply = (result, status = 200) => Response.json({ success: status < 400, errors: status < 400 ? [] : [{ message: result }], result: status < 400 ? result : null }, { status });

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/client\/v4/, '');
    if (path === '/__state') return Response.json({ routes, records });
    if (request.headers.get('Authorization') !== 'Bearer test-cf-token') return reply('Authentication error', 403);

    if (request.method === 'GET' && path === '/zones') {
      return reply(zones.filter((zone) => zone.name === url.searchParams.get('name')));
    }
    const match = /^\/zones\/zone-1\/(workers\/routes|dns_records)(?:\/([^/]+))?$/.exec(path);
    if (!match) return reply('Not found', 404);
    const [, kind, id] = match;
    const list = kind === 'dns_records' ? records : routes;

    if (request.method === 'GET' && !id) {
      if (kind === 'workers/routes') return reply(routes);
      return reply(records.filter((record) => record.name === url.searchParams.get('name')));
    }
    if (request.method === 'POST' && !id) {
      const body = await request.json();
      if (kind === 'workers/routes') {
        if (body.pattern.includes('fail-route')) return reply('Internal error', 500);
        const route = { id: `route-${++sequence}`, pattern: body.pattern, script: body.script };
        routes.push(route);
        return reply(route);
      }
      if (hidden.has(body.name) || records.some((record) => record.name === body.name)) {
        return reply('An A, AAAA, or CNAME record with that host already exists.', 400);
      }
      const record = { id: `dns-new-${++sequence}`, name: body.name, type: body.type, comment: body.comment ?? null };
      records.push(record);
      return reply(record);
    }
    if (request.method === 'DELETE' && id) {
      const index = list.findIndex((item) => item.id === id);
      if (index === -1) return reply('Not found', 404);
      list.splice(index, 1);
      return reply({ id });
    }
    return reply('Method not allowed', 405);
  },
};
