'use strict';
// Fake Rally WSAPI for tests: users in memory, 200-with-Errors failures like real WSAPI.
const http = require('http');
function startMockRally(port) {
  const state = { users: new Map(), nextId: 1000, fail: false, requests: [], delayMs: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null, key: req.headers.zsessionid });
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      // 'test-key' belongs to a Subscription Administrator, 'plain-key' to an ordinary user.
      const keys = { 'test-key': true, 'plain-key': false };
      if (!(req.headers.zsessionid in keys)) return send(401, {});
      const base = '/slm/webservice/v2.0';
      const p = url.pathname.slice(base.length);
      if (req.method === 'GET' && p === '/user:current') {
        const admin = keys[req.headers.zsessionid];
        return send(200, { User: { ObjectID: 1, UserName: admin ? 'rally-admin@corp.com' : 'someone@corp.com', SubscriptionAdmin: admin, SubscriptionPermission: admin ? 'Subscription Admin' : 'Workspace User', Errors: [], Warnings: [] } });
      }
      if (state.fail) {
        const env = req.method === 'GET' ? 'QueryResult' : (p.endsWith('/create') ? 'CreateResult' : 'OperationResult');
        return send(200, { [env]: { Errors: ['Simulated Rally failure'], Warnings: [] } });
      }
      if (req.method === 'GET' && p === '/user') {
        const q = url.searchParams.get('query');
        if (!q) {
          // Paged listing, 1-based start, like WSAPI.
          const all = [...state.users.values()].sort((a, b) => a.ObjectID - b.ObjectID);
          const start = Number(url.searchParams.get('start') || 1); const size = Number(url.searchParams.get('pagesize') || 20);
          return send(200, { QueryResult: { Errors: [], Warnings: [], TotalResultCount: all.length, StartIndex: start, PageSize: size, Results: all.slice(start - 1, start - 1 + size) } });
        }
        const m = /\(EmailAddress = "(.*)"\)/.exec(q);
        const results = [...state.users.values()].filter((u) => m && u.EmailAddress === m[1]);
        return send(200, { QueryResult: { Errors: [], Warnings: [], TotalResultCount: results.length, Results: results } });
      }
      if (req.method === 'POST' && p === '/user/create') {
        const f = JSON.parse(body).User;
        for (const r of ['EmailAddress', 'Language', 'Locale', 'sessionTimeout']) if (f[r] === undefined) return send(200, { CreateResult: { Errors: [`${r} is required`] } });
        const u = { ObjectID: state.nextId++, ObjectUUID: `uuid-${state.nextId}`, UserName: f.EmailAddress, Disabled: false, ...f };
        state.users.set(u.ObjectID, u);
        return send(200, { CreateResult: { Errors: [], Warnings: [], Object: u } });
      }
      const m = /^\/user\/(\d+)$/.exec(p);
      if (m) {
        const u = state.users.get(Number(m[1]));
        if (!u) return send(200, { OperationResult: { Errors: ['Cannot find object'] } });
        if (req.method === 'POST') { Object.assign(u, JSON.parse(body).User); return send(200, { OperationResult: { Errors: [], Object: u } }); }
        if (req.method === 'DELETE') { state.users.delete(u.ObjectID); return send(200, { OperationResult: { Errors: [], Warnings: [] } }); }
      }
      send(404, {});
    });
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ state, close: () => server.close() })));
}
module.exports = { startMockRally };
if (require.main === module) startMockRally(Number(process.argv[2] || 9911)).then(() => console.log('mock rally up'));
