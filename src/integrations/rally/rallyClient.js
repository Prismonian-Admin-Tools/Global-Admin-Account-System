'use strict';

/**
 * Minimal Rally WebService API (WSAPI v2.0) client — only the User calls
 * Passport's account sync needs (see rallySync.js).
 *
 * Authenticates with a Rally API key in the ZSESSIONID header. That, unlike
 * HTTP Basic auth, needs no per-session CSRF SecurityToken (`?key=`) on
 * writes — see the spec's x-behavior-notes.security-token.
 *
 * WSAPI reports most failures (validation, permissions, bad queries) as
 * HTTP 200 with an `Errors` array populated, not as a 4xx/5xx — so every
 * response's Errors is checked here and turned into a thrown RallyError,
 * and callers never have to remember to.
 */

const API_PATH = '/slm/webservice/v2.0';

const USER_LIST_FIELDS = [
  'ObjectID', 'ObjectUUID', 'UserName', 'EmailAddress', 'FirstName', 'LastName', 'DisplayName',
  'Disabled', 'SubscriptionAdmin', 'SubscriptionPermission', 'LastLoginDate',
].join(',');

class RallyError extends Error {
  constructor(message, { status = null, errors = [] } = {}) {
    super(message);
    this.name = 'RallyError';
    this.status = status;
    this.errors = errors;
  }
}

// Rally's query language quotes string values with "..."; refusing these
// characters outright is simpler and safer than guessing at an escaping
// rule the spec doesn't document. No real mailbox needs them.
const QUERY_SAFE_EMAIL = /^[^\s"\\()]+@[^\s"\\()]+$/;

function isQuerySafeEmail(email) {
  return typeof email === 'string' && email.length <= 254 && QUERY_SAFE_EMAIL.test(email);
}

class RallyClient {
  constructor({ baseUrl, apiKey, timeoutMs = 15000, fetchImpl = globalThis.fetch }) {
    if (!baseUrl) throw new Error('Rally baseUrl is required');
    if (!apiKey) throw new Error('Rally apiKey is required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async request(method, path, { query, body } = {}) {
    const url = new URL(`${this.baseUrl}${API_PATH}${path}`);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers: {
          ZSESSIONID: this.apiKey,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? `timed out after ${this.timeoutMs}ms` : err.message;
      throw new RallyError(`Rally ${method} ${path} failed: ${reason}`);
    }

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body, handled below */ }

    if (!res.ok) {
      const errors = extractErrors(json);
      const detail = errors.length ? errors.join('; ') : (text || res.statusText).slice(0, 300);
      throw new RallyError(`Rally ${method} ${path} returned HTTP ${res.status}: ${detail}`, { status: res.status, errors });
    }
    if (!json) throw new RallyError(`Rally ${method} ${path} returned a non-JSON response`, { status: res.status });

    const errors = extractErrors(json);
    if (errors.length) {
      throw new RallyError(`Rally ${method} ${path} rejected the request: ${errors.join('; ')}`, { status: res.status, errors });
    }
    return unwrap(json);
  }

  /** The (at most one) Rally user with this exact email address, or null. */
  async findUserByEmail(email) {
    if (!isQuerySafeEmail(email)) throw new RallyError(`Email address "${email}" can't be used in a Rally query`);
    const result = await this.request('GET', '/user', {
      query: {
        query: `(EmailAddress = "${email}")`,
        fetch: 'ObjectID,ObjectUUID,EmailAddress,UserName,Disabled',
        pagesize: 2,
      },
    });
    const results = (result && result.Results) || [];
    if (results.length > 1) throw new RallyError(`More than one Rally user has the email address "${email}"`);
    return results[0] || null;
  }

  /**
   * Every Rally user in the subscription the API key can see, paging
   * through GET /user (WSAPI paging is 1-based `start` + `pagesize`).
   * Ordered by ObjectID so pages stay stable while we walk them.
   */
  async listUsers({ fetch = USER_LIST_FIELDS, pageSize = 200, maxUsers = 100000 } = {}) {
    const users = [];
    let start = 1;
    for (;;) {
      const page = await this.request('GET', '/user', { query: { fetch, pagesize: pageSize, start, order: 'ObjectID' } });
      const results = (page && page.Results) || [];
      users.push(...results);
      const total = Number(page && page.TotalResultCount) || 0;
      start += results.length;
      if (!results.length || start > total) break;
      if (users.length >= maxUsers) throw new RallyError(`Rally returned more than ${maxUsers} users; refusing to continue`);
    }
    return users;
  }

  /** Fields: EmailAddress, Language, Locale, sessionTimeout (all required), plus any optional writable User field. */
  async createUser(fields) {
    const result = await this.request('POST', '/user/create', { body: { User: fields } });
    const user = result && result.Object;
    if (!user || !user.ObjectID) throw new RallyError('Rally accepted the user create but returned no ObjectID');
    return user;
  }

  async setUserDisabled(objectId, disabled) {
    return this.request('POST', `/user/${encodeURIComponent(objectId)}`, { body: { User: { Disabled: Boolean(disabled) } } });
  }

  /** Permanent in Rally. A user that's already gone (HTTP 404) counts as deleted. */
  async deleteUser(objectId) {
    try {
      await this.request('DELETE', `/user/${encodeURIComponent(objectId)}`);
    } catch (err) {
      if (err instanceof RallyError && err.status === 404) return;
      throw err;
    }
  }
}

// WSAPI wraps every response in one envelope key (CreateResult,
// OperationResult, QueryResult); the spec also documents some operations
// returning Errors at the top level. Accept both.
function unwrap(json) {
  for (const key of ['CreateResult', 'OperationResult', 'QueryResult']) {
    if (json && typeof json[key] === 'object' && json[key] !== null) return json[key];
  }
  return json;
}

function extractErrors(json) {
  if (!json || typeof json !== 'object') return [];
  const env = unwrap(json);
  const errors = [...(Array.isArray(env.Errors) ? env.Errors : [])];
  if (env !== json && Array.isArray(json.Errors)) errors.push(...json.Errors);
  return errors.filter(Boolean).map(String);
}

module.exports = { RallyClient, RallyError, isQuerySafeEmail };
