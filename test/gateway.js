const admin = 'https://admin.example.test';
const app = 'https://app.example.test';
const alias = 'https://www.app.example.test';
const preview = 'https://preview.example.test';
const other = 'https://other.example.test';
const policyUrl = `${admin}/api/domains/app.example.test`;
const otherPolicyUrl = `${admin}/api/domains/other.example.test`;
const operator = { Authorization: `Basic ${btoa('operator:test-admin')}` };
const user = { Authorization: `Basic ${btoa('preview:test-app')}` };
const release = { Authorization: 'Bearer test-release' };

function assert(value, label) {
  if (!value) throw new Error(label);
}

function equal(actual, expected, label) {
  assert(actual === expected, `${label}: expected ${expected}, received ${actual}`);
}

export default {
  async test(_controller, env) {
    const fetch = async (url, init) => {
      const response = await env.GATEWAY.fetch(new Request(url, init));
      return new Response(response.body ? await response.arrayBuffer() : null, response);
    };
    const patch = (url, value, headers = operator) => fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(value),
    });

    equal((await fetch(admin)).status, 401, 'dashboard requires credentials');
    equal((await fetch(`${admin}/dashboard.js`)).status, 401, 'assets require credentials');
    const signedOut = { Authorization: `Basic ${btoa('signed-out:signed-out')}` };
    equal((await fetch(`${admin}/logout`, { headers: operator })).status, 401, 'logout rejects the real login');
    equal((await fetch(`${admin}/logout`, { headers: signedOut })).status, 200, 'logout accepts the placeholder login');
    equal((await fetch(`${admin}/api/domains`, { headers: signedOut })).status, 401, 'placeholder login cannot use the dashboard');
    equal((await fetch(`${admin}/signed-out`)).status, 200, 'signed-out page is open');
    equal((await fetch(`${admin}/theme.js`, { headers: operator })).status, 200, 'theme script');
    equal((await fetch(`${policyUrl}/audit`, { headers: user })).status, 401, 'preview cannot read audit');
    const dashboard = await fetch(admin, { headers: operator });
    equal(dashboard.status, 200, 'admin dashboard');
    assert((await dashboard.text()).includes('Managed domains'), 'dashboard markup');
    equal((await fetch('https://unknown.example.test')).status, 404, 'unknown hostname blocked');
    equal((await fetch(app)).status, 200, 'public without maintenance or auth');
    equal((await (await fetch(alias)).json()).hostname, 'www.app.example.test', 'alias forwards its own hostname');
    const listed = await (await fetch(`${admin}/api/domains`, { headers: operator })).json();
    equal(listed[0].aliases[0], 'www.app.example.test', 'domain list includes aliases');
    equal((await fetch(preview)).status, 401, 'preview always protected');

    equal((await patch(policyUrl, { maintenanceEnabled: true }, user)).status, 401, 'preview cannot write');
    equal((await patch(policyUrl, { maintenanceEnabled: true }, { ...operator, Origin: other })).status, 403, 'cross-origin writes rejected');
    equal((await patch(policyUrl, { maintenanceEnabled: 'true' })).status, 400, 'invalid boolean rejected');
    equal((await patch(otherPolicyUrl, { basicAuthEnabled: true })).status, 409, 'missing credentials block enabling auth');
    equal((await patch(policyUrl, { basicAuthEnabled: true })).status, 200, 'enable Basic Auth');
    const challenge = await fetch(app);
    equal(challenge.status, 401, 'public Basic Auth gate');
    equal((await fetch(alias)).status, 401, 'alias shares Basic Auth policy');
    assert(challenge.headers.get('WWW-Authenticate').startsWith('Basic '), 'browser challenge');
    const forwarded = await fetch(`${app}/orders?limit=1`, { method: 'POST', headers: user, body: 'order' });
    equal(forwarded.status, 200, 'valid public credential');
    equal(forwarded.headers.get('Cache-Control'), 'private, no-store', 'protected response cache policy');
    const order = await forwarded.json();
    equal(order.authorization, null, 'gateway credential stripped');
    equal(order.body, 'order', 'request body forwarded');
    equal(order.path, '/orders?limit=1', 'path and query forwarded');

    const retryAfterAt = new Date(Date.now() + 86_400_000).toISOString();
    const settings = { maintenanceEnabled: true, maintenanceMessage: '<b>Deploying</b>', retryAfterAt };
    equal((await patch(policyUrl, settings, { ...operator, 'If-Match': '"0"' })).status, 412, 'stale revision rejected');
    equal((await patch(policyUrl, settings, { ...operator, 'If-Match': '"1"' })).status, 200, 'enable maintenance');
    const maintenance = await fetch(app, { headers: user });
    equal(maintenance.status, 503, 'maintenance takes precedence over Basic Auth');
    equal((await fetch(alias)).status, 503, 'alias shares maintenance policy');
    equal(maintenance.headers.get('Retry-After'), new Date(retryAfterAt).toUTCString(), 'Retry-After header');
    equal(maintenance.headers.get('Cache-Control'), 'no-store', 'maintenance cache policy');
    assert((await maintenance.text()).includes('&lt;b&gt;Deploying&lt;/b&gt;'), 'maintenance message escaped');
    equal((await fetch(app, { method: 'HEAD' })).body, null, 'HEAD omits maintenance body');
    equal((await fetch(preview)).status, 401, 'maintenance preview rejects anonymous access');
    const previewApp = await fetch(preview, { headers: user });
    equal((await previewApp.json()).hostname, 'app.example.test', 'preview forwards via app hostname');
    const redirect = await fetch(`${preview}/redirect`, { headers: user, redirect: 'manual' });
    equal(redirect.status, 302, 'preview keeps redirect status');
    equal(redirect.headers.get('Location'), `${preview}/destination`, 'preview redirect stays on preview');
    equal((await fetch(other)).status, 200, 'policy isolated by hostname');

    equal((await patch(otherPolicyUrl, { maintenanceEnabled: true }, release)).status, 401, 'release token scoped to one domain');
    equal((await patch(policyUrl, { basicAuthEnabled: false }, release)).status, 403, 'release token can only control maintenance');
    equal((await patch(policyUrl, { maintenanceEnabled: false }, release)).status, 200, 'release automation reopens gate');
    equal((await patch(policyUrl, { maintenanceEnabled: false }, release)).status, 200, 'release retry is idempotent');
    equal((await fetch(app)).status, 401, 'Basic Auth resumes after maintenance');
    equal((await patch(policyUrl, { basicAuthEnabled: false })).status, 200, 'turn off Basic Auth');
    equal((await patch(policyUrl, { maintenanceEnabled: true }, release)).status, 200, 'maintenance with Basic Auth off');
    equal((await fetch(app)).status, 503, 'public without Basic Auth still sees maintenance');
    const audit = await (await fetch(`${policyUrl}/audit`, { headers: operator })).json();
    equal(audit.length, 5, 'audit excludes rejected and duplicate changes');
    equal(audit[0].actor, 'deployment', 'audit release actor');
    equal(audit[1].actor, 'operator', 'audit operator identity');
    equal(audit[3].changes.length, 3, 'atomic policy update audit');

    const put = (url, value, headers = operator) => fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(value),
    });
    const newLogin = { username: 'site-preview', password: 'a-long-dashboard-password' };
    const newUser = { Authorization: `Basic ${btoa(`${newLogin.username}:${newLogin.password}`)}` };
    const otherLogin = `${otherPolicyUrl}/login`;
    equal((await put(otherLogin, { username: 'x', password: 'short' })).status, 400, 'short password rejected');
    equal((await put(otherLogin, { username: 'a:b', password: newLogin.password })).status, 400, 'colon in username rejected');
    equal((await put(otherLogin, newLogin, release)).status, 401, 'release token cannot set logins');
    equal((await put(otherLogin, newLogin, user)).status, 401, 'preview credential cannot set logins');
    equal((await put(otherLogin, newLogin, { ...operator, Origin: other })).status, 403, 'cross-origin login change rejected');
    const saved = await put(otherLogin, newLogin);
    equal(saved.status, 200, 'set dashboard login');
    const savedText = await saved.text();
    const savedPolicy = JSON.parse(savedText);
    equal(savedPolicy.loginSource, 'dashboard', 'login source reported');
    equal(savedPolicy.login.username, newLogin.username, 'login username reported');
    assert(!/hash|salt/.test(savedText), 'login digest never returned');
    equal((await patch(otherPolicyUrl, { basicAuthEnabled: true })).status, 200, 'dashboard login allows Basic Auth');
    equal((await fetch(other)).status, 401, 'dashboard login gate');
    equal((await fetch(other, { headers: user })).status, 401, 'another domain login rejected');
    equal((await fetch(other, { headers: newUser })).status, 200, 'dashboard login accepted');
    const otherAudit = await (await fetch(`${otherPolicyUrl}/audit`, { headers: operator })).text();
    equal(JSON.parse(otherAudit)[1].changes[0].field, 'previewLogin', 'login change audited');
    assert(!otherAudit.includes(newLogin.password) && !/hash|salt/.test(otherAudit), 'audit omits login secrets');

    equal((await put(`${policyUrl}/login`, newLogin)).status, 200, 'replace deploy secret with dashboard login');
    equal((await fetch(preview, { headers: user })).status, 401, 'deploy secret no longer accepted');
    equal((await fetch(preview, { headers: newUser })).status, 200, 'preview uses dashboard login');

    equal((await patch(policyUrl, { managed: false }, release)).status, 403, 'release token cannot unmanage');
    equal((await patch(policyUrl, { managed: 'no' })).status, 400, 'invalid managed value rejected');
    equal((await patch(policyUrl, { managed: false })).status, 200, 'stop managing domain');
    const bypass = await fetch(app, { headers: user });
    equal(bypass.status, 200, 'unmanaged domain bypasses maintenance');
    equal((await bypass.json()).authorization, user.Authorization, 'unmanaged domain keeps Authorization');
    equal((await fetch(alias)).status, 200, 'unmanaged alias bypasses maintenance');
    equal((await fetch(preview)).status, 401, 'unmanaged preview stays protected');
    equal((await patch(policyUrl, { managed: true })).status, 200, 'resume managing domain');
    equal((await fetch(app)).status, 503, 'maintenance resumes');

    const allowUrl = `${policyUrl}/allowlist`;
    const fromIp = (ip, headers = {}) => ({ headers: { 'CF-Connecting-IP': ip, ...headers } });
    const putAllow = (entries, headers = operator) => put(allowUrl, { entries }, headers);
    equal((await putAllow([{ ip: '300.1.1.1' }])).status, 400, 'invalid IP rejected');
    equal((await putAllow([{ ip: '10.0.0.0/4' }])).status, 400, 'overly broad IPv4 range rejected');
    equal((await putAllow([{ ip: '2001:db8::/16' }])).status, 400, 'overly broad IPv6 range rejected');
    equal((await putAllow([{ ip: '203.0.113.7', label: 'x'.repeat(61) }])).status, 400, 'long label rejected');
    const tooMany = Array.from({ length: 201 }, (_, index) => ({ ip: `10.0.0.${index}` }));
    equal((await putAllow(tooMany)).status, 400, 'more than 200 entries rejected');
    equal((await putAllow([{ ip: '203.0.113.7' }], release)).status, 401, 'release token cannot edit allowlist');
    equal((await putAllow([{ ip: '203.0.113.7' }], user)).status, 401, 'preview login cannot edit allowlist');
    equal((await putAllow([{ ip: '203.0.113.7' }], { ...operator, Origin: other })).status, 403, 'cross-origin allowlist change rejected');
    equal((await putAllow([{ ip: '203.0.113.7' }], { ...operator, 'If-Match': '"1"' })).status, 412, 'stale allowlist revision rejected');

    const allowed = await putAllow([
      { ip: '203.0.113.7', label: 'Office' },
      { ip: '198.51.100.77/24', label: 'VPN' },
      { ip: '2001:DB8:abcd:12::1/64', label: 'Home' },
      { ip: ' 203.0.113.7 ', label: 'Duplicate' },
    ]);
    equal(allowed.status, 200, 'save allowlist');
    const allowedPolicy = await allowed.json();
    equal(allowedPolicy.allowlist.map((entry) => entry.cidr).join(' '),
      '203.0.113.7/32 198.51.100.0/24 2001:db8:abcd:12::/64', 'allowlist normalized and deduplicated');
    equal(allowedPolicy.allowlist[0].label, 'Office', 'first label kept for duplicates');

    equal((await fetch(app, fromIp('192.0.2.1'))).status, 503, 'other IPs still see maintenance');
    equal((await fetch(app)).status, 503, 'requests without a client IP see maintenance');
    equal((await fetch(app, fromIp('203.0.113.7'))).status, 200, 'allowed IPv4 address bypasses maintenance');
    equal((await fetch(app, fromIp('198.51.100.200'))).status, 200, 'allowed IPv4 range bypasses maintenance');
    equal((await fetch(app, fromIp('::ffff:198.51.100.9'))).status, 200, 'IPv4-mapped address matches IPv4 range');
    equal((await fetch(app, fromIp('2001:db8:abcd:12:ffff::1'))).status, 200, 'allowed IPv6 range bypasses maintenance');
    equal((await fetch(app, fromIp('2001:db8:abcd:13::1'))).status, 503, 'IPv6 address outside the range is blocked');
    equal((await fetch(alias, fromIp('203.0.113.7'))).status, 200, 'alias honors the allowlist');
    equal((await fetch(preview, fromIp('203.0.113.7'))).status, 401, 'preview still needs its login');

    equal((await patch(policyUrl, { maintenanceEnabled: false, basicAuthEnabled: true })).status, 200, 'Basic Auth on with an allowlist');
    equal((await fetch(app, fromIp('203.0.113.7'))).status, 200, 'allowed IP skips Basic Auth');
    equal((await fetch(app, fromIp('192.0.2.1'))).status, 401, 'other IPs get the Basic Auth challenge');

    const addedAudit = await (await fetch(`${policyUrl}/audit`, { headers: operator })).json();
    const added = addedAudit[1].changes;
    equal(added.length, 3, 'each added entry audited');
    equal(added[0].after, '203.0.113.7/32 (Office)', 'audit describes the entry');
    equal(added[0].before, null, 'audit marks the entry as added');

    equal((await putAllow([{ ip: '203.0.113.7', label: 'Office' }])).status, 200, 'remove entries');
    const removed = (await (await fetch(`${policyUrl}/audit`, { headers: operator })).json())[0].changes;
    equal(removed.length, 2, 'each removed entry audited');
    assert(removed.every((change) => change.after === null), 'audit marks entries as removed');
    equal((await fetch(app, fromIp('198.51.100.200'))).status, 401, 'removed range no longer allowed');
    equal((await putAllow([{ ip: '203.0.113.7', label: 'Office' }])).status, 200, 'unchanged allowlist accepted');
    equal((await (await fetch(`${policyUrl}/audit`, { headers: operator })).json())[0].changes.length, 2, 'unchanged allowlist not audited');

    const client = await (await fetch(`${admin}/api/client-ip`, { headers: { ...operator, 'CF-Connecting-IP': '2001:db8:abcd:12:a:b:c:d' } })).json();
    equal(client.ip, '2001:db8:abcd:12:a:b:c:d', 'client IP reported');
    equal(client.suggested, '2001:db8:abcd:12::/64', 'client IPv6 suggestion uses its /64');
    equal((await fetch(`${admin}/api/client-ip`, fromIp('203.0.113.7'))).status, 401, 'client IP lookup needs the admin login');

    const cfState = async () => (await env.CLOUDFLARE.fetch('https://api.cloudflare.com/__state')).json();
    const post = (url, value, headers = operator) => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    const remove = (url, headers = operator) => fetch(url, { method: 'DELETE', headers });
    const domainsUrl = `${admin}/api/domains`;
    const ours = (state, pattern) => state.routes.some((route) => route.pattern === pattern && route.script === 'maintenance-manager-test');

    const apps = await (await fetch(`${admin}/api/apps`, { headers: operator })).json();
    equal(apps.cloudflare, true, 'Cloudflare API reported as configured');
    equal(apps.apps[0].binding, 'APP', 'app Workers listed');
    let routeStatus = await (await fetch(`${admin}/api/route-status`, { headers: operator })).json();
    equal(routeStatus.domains['app.example.test'].connected, false, 'seeded domain starts without routes');

    equal((await post(`${policyUrl}/connect`, undefined, release)).status, 401, 'release token cannot connect domains');
    equal((await post(`${policyUrl}/connect`, undefined, { ...operator, Origin: other })).status, 403, 'cross-origin connect rejected');
    equal((await post(`${policyUrl}/connect`)).status, 200, 'connect seeded domain');
    let state = await cfState();
    assert(['app.example.test/*', 'www.app.example.test/*', 'preview.example.test/*'].every((pattern) => ours(state, pattern)),
      'routes created for hostname, alias and preview');
    assert(state.records.some((record) => record.name === 'preview.example.test' && record.comment === 'Managed by maintenance-manager'),
      'preview DNS record created and labeled');
    const routeCount = state.routes.length;
    equal((await post(`${policyUrl}/connect`)).status, 200, 'connect can be repeated');
    equal((await cfState()).routes.length, routeCount, 'repeated connect adds nothing');
    routeStatus = await (await fetch(`${admin}/api/route-status`, { headers: operator })).json();
    equal(routeStatus.domains['app.example.test'].connected, true, 'route status reports connected');

    const newDomain = { hostname: 'New.Example.test', service: 'APP', preview: 'new-preview.example.test' };
    equal((await post(domainsUrl, newDomain, release)).status, 401, 'release token cannot add domains');
    equal((await post(domainsUrl, newDomain, user)).status, 401, 'preview login cannot add domains');
    equal((await post(domainsUrl, newDomain, { ...operator, Origin: other })).status, 403, 'cross-origin add rejected');
    equal((await post(domainsUrl, { ...newDomain, service: 'NOPE' })).status, 400, 'unknown app Worker rejected');
    equal((await post(domainsUrl, { ...newDomain, hostname: 'not a host' })).status, 400, 'invalid hostname rejected');
    equal((await post(domainsUrl, { ...newDomain, hostname: 'blog.elsewhere.test' })).status, 400, 'hostname outside the zones rejected');
    equal((await post(domainsUrl, { ...newDomain, hostname: 'app.example.test' })).status, 409, 'hostname already listed rejected');
    equal((await post(domainsUrl, { ...newDomain, preview: 'www.app.example.test' })).status, 409, 'alias of another domain rejected');
    equal((await post(domainsUrl, { ...newDomain, preview: 'admin.example.test' })).status, 409, 'dashboard hostname rejected');
    equal((await post(domainsUrl, { hostname: 'taken.example.test', service: 'APP' })).status, 409, "another Worker's route is not taken over");

    const beforeFailure = JSON.stringify(await cfState());
    const failed = await post(domainsUrl, {
      hostname: 'fail.example.test', aliases: ['fail-route.example.test'], preview: 'fail-preview.example.test', service: 'APP',
    });
    equal(failed.status, 502, 'Cloudflare failure reported');
    assert((await failed.json()).error.startsWith('Cloudflare:'), 'Cloudflare error message passed on');
    equal(JSON.stringify(await cfState()), beforeFailure, 'failed add rolled back its routes and DNS record');
    equal((await fetch('https://fail.example.test')).status, 404, 'failed add not registered');

    const addedDomain = await post(domainsUrl, newDomain);
    equal(addedDomain.status, 201, 'add domain');
    equal((await addedDomain.json()).domain.hostname, 'new.example.test', 'hostname normalized to lowercase');
    state = await cfState();
    assert(ours(state, 'new.example.test/*') && ours(state, 'new-preview.example.test/*'), 'routes created for the new domain');
    const served = await fetch('https://new.example.test/hello');
    equal(served.status, 200, 'new domain serves the app');
    equal((await served.json()).hostname, 'new.example.test', 'new domain forwards its hostname');
    equal((await fetch('https://new-preview.example.test')).status, 503, 'new preview waits for a login');
    const listedDomains = await (await fetch(domainsUrl, { headers: operator })).json();
    equal(listedDomains.at(-1).hostname, 'new.example.test', 'new domain listed last');

    const noDns = await post(domainsUrl, { hostname: 'nodns.example.test', service: 'APP' });
    equal(noDns.status, 201, 'domain without a DNS record can be added');
    assert((await noDns.json()).warnings[0].includes('No DNS record'), 'missing DNS record reported as a warning');
    equal((await remove(`${domainsUrl}/nodns.example.test`)).status, 200, 'remove domain without a preview');

    const newPolicy = `${domainsUrl}/new.example.test`;
    equal((await patch(newPolicy, { maintenanceEnabled: true })).status, 200, 'turn on maintenance for the new domain');
    equal((await remove(newPolicy, release)).status, 401, 'release token cannot remove domains');
    equal((await remove(newPolicy, { ...operator, Origin: other })).status, 403, 'cross-origin remove rejected');
    equal((await remove(policyUrl)).status, 409, 'release domain cannot be removed');
    const removedDomain = await remove(newPolicy);
    equal(removedDomain.status, 200, 'remove domain');
    state = await cfState();
    assert(!state.routes.some((route) => route.pattern.startsWith('new')), 'routes removed');
    assert(!state.records.some((record) => record.name === 'new-preview.example.test'), 'preview DNS record removed');
    assert(state.routes.some((route) => route.pattern === 'taken.example.test/*'), "other Worker's route untouched");
    equal((await fetch('https://new.example.test')).status, 404, 'removed domain no longer served');
    equal((await post(domainsUrl, newDomain)).status, 201, 'add the domain again');
    equal((await fetch('https://new.example.test')).status, 503, 'settings return when a domain is added again');

    equal((await post(domainsUrl, { hostname: 'site.example.test', preview: 'custom-preview.example.test', service: 'APP' })).status, 201,
      'existing preview record reused');
    equal((await cfState()).records.filter((record) => record.name === 'custom-preview.example.test').length, 1, 'no duplicate preview record');
    const leftover = await (await remove(`${domainsUrl}/site.example.test`)).json();
    assert(leftover.warnings[0].includes('custom-preview.example.test'), 'record the dashboard did not create is reported');
    assert((await cfState()).records.some((record) => record.name === 'custom-preview.example.test'), 'record the dashboard did not create is kept');
    equal((await post(domainsUrl, { hostname: 'cd.example.test', preview: 'cd-preview.example.test', service: 'APP' })).status, 201,
      'preview owned by a custom domain is accepted');
    assert(ours(await cfState(), 'cd-preview.example.test/*'), 'route added in front of the custom domain preview');
  },
};
