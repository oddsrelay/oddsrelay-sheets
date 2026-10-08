// Runs src/Logic.js and src/Code.gs in one Node vm context, as Apps Script runs them in one global scope,
// with Google's services stubbed. Replies come from the API description's examples. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

const src = path.join(__dirname, '..', 'src');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value)); // values from the vm realm, for deepEqual
const KEY = 'sheets-test-key-a1b2c3d4';

function response(status, body, headers = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  return {
    getResponseCode: () => status,
    getContent: () => Array.from(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length)),
    getContentText: () => bytes.toString('utf8'),
    getHeaders: () => headers,
    getBlob: () => ({ bytes, setContentType() { return this; } }),
  };
}

/** A fresh add-on. `reply(url)` answers each fetch; every fetch is recorded in `calls`. */
function addon({ key = KEY, reply = () => response(200, '{}') } = {}) {
  const props = new Map(key ? [['ODDSRELAY_KEY', key]] : []);
  const cache = new Map();
  const calls = [];
  const slept = [];
  const menu = [];
  const ctx = vm.createContext({
    UrlFetchApp: { fetch: (url, options) => { calls.push({ url, options }); return reply(url, calls.length); } },
    PropertiesService: {
      getUserProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, v),
        deleteProperty: (k) => props.delete(k),
      }),
    },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest: (alg, value) => Array.from(new Int8Array(crypto.createHash('sha256').update(value).digest())),
      ungzip: (blob) => ({ getDataAsString: () => zlib.gunzipSync(blob.bytes).toString('utf8') }),
      sleep: (ms) => slept.push(ms),
    },
    SpreadsheetApp: {
      getUi: () => ({
        createAddonMenu() {
          const m = { addItem: (label, fn) => { menu.push(fn); return m; }, addToUi: () => {} };
          return m;
        },
      }),
    },
  });
  for (const file of ['Logic.js', 'Code.gs']) {
    vm.runInContext(fs.readFileSync(path.join(src, file), 'utf8'), ctx, { filename: file });
  }
  return { ctx, props, cache, calls, slept, menu };
}

test('board request: ranges and comma lists become query values; aliases pass', () => {
  const { ctx } = addon();
  const req = ctx.boardRequest_(' Each_Way ', { sports: [['horse_racing'], ['']], bookmakers: 'bet365, ladbrokes,' });
  assert.equal(req.path, '/v2/odds/each_way');
  assert.equal(ctx.buildUrl_(req.path, req.params),
    'https://api.oddsrelay.io/v2/odds/each_way?sports=horse_racing&bookmakers=bet365%2Cladbrokes');
  assert.throws(() => ctx.boardRequest_('sheets-typo-value', {}), (e) => !e.message.includes('sheets-typo'));
  assert.equal(ctx.maxTokensParam_(''), vm.runInContext('DEFAULT_MAX_TOKENS', ctx));
  assert.throws(() => ctx.maxTokensParam_('lots'), /max_tokens/);
});

test('rows: back and lay arrays, one row per offer, under the header', () => {
  const { ctx } = addon();
  const rows = plain(ctx.boardRows_(JSON.parse(fixture('v2-odds-type.bog_bare.json'))));
  assert.equal(rows[0][0], 'Commence time');
  assert.equal(rows.length, 1 + 4);
  assert.deepEqual(rows[1], ['2026-09-17T12:30:00Z', 'Horse Racing', 'Ayr', 'win', 'Bassrah', '', 'back', 'ladbrokes',
    4, '', '', '', '', 'https://www.ladbrokes.com/en/sports/event/258542357', 'or_evt_58ab94d71497']);
  assert.deepEqual(rows[4].slice(6, 10), ['lay', 'smarkets', 4.4, 75.93]);
  assert.ok(rows.every((r) => r.length === rows[0].length));
});

test('rows: each-way lays split into win and place, with terms', () => {
  const { ctx } = addon();
  const rows = plain(ctx.boardRows_(JSON.parse(fixture('v2-odds-type.each_way.json'))));
  assert.deepEqual(rows.slice(1).map((r) => r[6]), ['back', 'lay win', 'lay place']);
  assert.deepEqual(rows[1].slice(7, 12), ['kwiff', 2.7, '', 3, 0.2]);
  assert.deepEqual(rows[3].slice(7, 11), ['betfair_exchange', 2.16, 39.42, 3]);
});

test('rows: dutching legs keep their dutch id, a line and a one-name fixture', () => {
  const { ctx } = addon();
  const board = { data: [{ event_id: 'or_evt_1', sport_key: 's', sport_title: 'S', commence_time: null,
    event_name: 'Home v Away', markets: [{ key: 'totals', outcomes: [
      { name: 'Over', point: 2.5, back: [{ bookmaker: 'b1', price: 2, link: null, dutch_id: 'ab12cd34' }] }] }] }] };
  assert.deepEqual(plain(ctx.boardRows_(board))[1],
    ['', 'S', 'Home v Away', 'totals', 'Over', 2.5, 'back', 'b1', 2, '', '', '', 'ab12cd34', '', 'or_evt_1']);
  assert.equal(ctx.boardRows_({ data: [] }).length, 1);
});

test('a board formula quotes first, then fetches with the key in the header only', () => {
  const quote = fixture('v2-odds-type.quote.json');
  const board = fixture('v2-odds-type.bog_bare.json');
  const { ctx, calls } = addon({ reply: (url) => response(200, url.includes('quote=true') ? quote : board) });
  const rows = ctx.ODDSRELAY_ODDS('bog', 'horse_racing', [['ladbrokes'], ['betfred']], '', '', '');
  assert.equal(rows.length, 5);
  assert.deepEqual(calls.map((c) => c.url), [
    'https://api.oddsrelay.io/v2/odds/bog?sports=horse_racing&bookmakers=ladbrokes%2Cbetfred&quote=true',
    'https://api.oddsrelay.io/v2/odds/bog?sports=horse_racing&bookmakers=ladbrokes%2Cbetfred',
  ]);
  for (const c of calls) {
    assert.equal(c.options.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(c.options.headers['Accept-Encoding'], 'gzip');
    assert.equal(c.options.muteHttpExceptions, true);
    assert.ok(!c.url.includes(KEY));
  }
});

test('a quote above the cap is refused and nothing else is fetched', () => {
  const { ctx, calls } = addon({ reply: () => response(200, '{"cost":900,"remaining":5000,"rate_card":"x"}') });
  assert.throws(() => ctx.ODDSRELAY_ODDS('standard', 'soccer', '', '', '', ''), /cost 900 tokens, above the cap of 500/);
  assert.equal(calls.length, 1);
  assert.throws(() => ctx.ODDSRELAY_ODDS('standard', 'soccer', '', '', '', 0), /above the cap of 0/);
  ctx.ODDSRELAY_ODDS('standard', 'soccer', '', '', '', 900);
  assert.equal(calls.length, 4);
});

test('the cache: a repeat is not fetched, another key is, and no key is stored', () => {
  const reply = (url) => response(200, url.includes('quote=true') ? fixture('v2-odds-type.quote.json') : '[]');
  const a = addon({ reply });
  a.ctx.ODDSRELAY_ODDS('bog', 'horse_racing', '', '', '', '');
  a.ctx.ODDSRELAY_ODDS('bog', 'horse_racing', '', '', '', '');
  assert.equal(a.calls.length, 2);
  assert.ok([...a.cache.keys(), ...a.cache.values()].every((s) => !s.includes(KEY)));
  const b = addon({ key: 'sheets-test-key-e5f6a7b8', reply });
  b.cache.set(...a.cache.entries().next().value);
  b.ctx.ODDSRELAY_ODDS('bog', 'horse_racing', '', '', '', '');
  assert.equal(b.calls.length, 2);
});

test('error cells: no key, refused key, 402, rate limits; the key never shows', () => {
  const none = addon({ key: null });
  assert.throws(() => none.ctx.ODDSRELAY_SPORTS(), /no API key saved/);
  assert.equal(none.calls.length, 0);

  const errorReply = (status, body, headers) => addon({ reply: () => response(status, body, headers) });
  assert.throws(() => errorReply(401, fixture('error-401.invalid_api_key.json')).ctx.ODDSRELAY_SPORTS(),
    /refused this key \(invalid_api_key\)/);
  assert.throws(() => errorReply(402, fixture('error-402.insufficient_tokens.json')).ctx.ODDSRELAY_BOOKMAKERS(),
    /insufficient_tokens: .*\(request or_req_0+\)/);
  assert.throws(() => errorReply(429, '', { 'retry-after': '30' }).ctx.ODDSRELAY_SPORTS(), /Try again in 30 seconds/);
  const echo = JSON.stringify({ error: { code: 'bad_request', message: `odd value ${KEY}` } });
  assert.throws(() => errorReply(400, echo).ctx.ODDSRELAY_SPORTS(), (e) => !e.message.includes(KEY) && /\[hidden\]/.test(e.message));

  const filter = addon();
  assert.throws(() => filter.ctx.ODDSRELAY_ODDS('standard', KEY, '', '', '', ''), /holds your API key/);
  assert.equal(filter.calls.length, 0);
});

test('a short Retry-After is waited out once', () => {
  const sports = fixture('v2-sports.page.json').replace(/"next_cursor": "[^"]+"/, '"next_cursor": null');
  const { ctx, calls, slept } = addon({
    reply: (url, n) => (n === 1 ? response(429, fixture('error-429.too_many_requests.json'), { 'Retry-After': '2' })
      : response(200, sports)),
  });
  assert.equal(ctx.ODDSRELAY_SPORTS().length, 3);
  assert.deepEqual(slept, [2000]);
  assert.equal(calls.length, 2);

  const busy = addon({ reply: () => response(429, '', { 'Retry-After': '2' }) });
  assert.throws(() => busy.ctx.ODDSRELAY_SPORTS(), /rate limited/);
  assert.equal(busy.calls.length, 2);
});

test('gzip bodies are decompressed; sports follow the cursor', () => {
  const page1 = fixture('v2-sports.page.json');
  const page2 = JSON.stringify({ meta: { next_cursor: null }, data: [{ key: 'tennis', group: 'Tennis', title: 'Tennis',
    active: true, has_outrights: false, markets: ['h2h'] }] });
  const { ctx, calls } = addon({ reply: (url) => response(200, zlib.gzipSync(url.includes('cursor=') ? page2 : page1)) });
  const rows = plain(ctx.ODDSRELAY_SPORTS());
  assert.deepEqual(rows[0], ['Key', 'Group', 'Title', 'Active', 'Outrights', 'Markets']);
  assert.deepEqual(rows[1], ['american_football_american_football', 'American Football', 'American Football', true,
    false, 'h2h,handicap_points,over_under_points']);
  assert.deepEqual(rows[3][0], 'tennis');
  assert.match(calls[1].url, /\/v2\/sports\?cursor=eyJ/);
});

test('bookmakers formula', () => {
  const { ctx } = addon({ reply: () => response(200, fixture('v2-bookmakers.catalogue.json')) });
  assert.deepEqual(plain(ctx.ODDSRELAY_BOOKMAKERS()).slice(0, 2), [['Key', 'Name', 'Exchange'], ['7bet', '7bet', false]]);
});

test('sidebar: a refused key is not saved; status never shows the key', () => {
  const refused = addon({ key: null, reply: () => response(401, fixture('error-401.invalid_api_key.json')) });
  assert.match(refused.ctx.saveKey(` ${KEY}\n`), /refused/);
  assert.equal(refused.props.size, 0);
  assert.match(refused.ctx.saveKey('has a space'), /does not look like a key/);
  assert.equal(refused.calls.length, 1);

  const ok = addon({ key: null });
  assert.equal(ok.ctx.keyStatus(), 'No key saved yet.');
  const said = ok.ctx.saveKey(` ${KEY} `);
  assert.ok(!said.includes(KEY.slice(-4)));
  assert.equal(ok.props.get('ODDSRELAY_KEY'), KEY);
  assert.match(ok.calls[0].url, /\/v2\/usage$/);
  assert.equal(ok.ctx.keyStatus(), 'A key is saved.');
  ok.ctx.clearKey();
  assert.equal(ok.props.size, 0);
});

test('sidebar page: its buttons reach the server functions and the field is emptied', () => {
  const server = addon({ key: null });
  const el = (id) => ({ id, value: '', textContent: '', onclick: null });
  const els = { key: el('key'), status: el('status'), save: el('save'), clear: el('clear') };
  const run = {
    withSuccessHandler(fn) { this.ok = fn; return this; },
    withFailureHandler(fn) { this.fail = fn; return this; },
  };
  for (const name of ['saveKey', 'clearKey', 'keyStatus']) run[name] = (arg) => run.ok(server.ctx[name](arg));
  const page = fs.readFileSync(path.join(src, 'Sidebar.html'), 'utf8');
  vm.runInNewContext(page.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document: { getElementById: (id) => els[id] },
    google: { script: { run } },
  });
  assert.equal(els.status.textContent, 'No key saved yet.');
  els.key.value = KEY;
  els.save.onclick();
  assert.equal(els.key.value, '');
  assert.equal(els.status.textContent, 'Key saved. The API accepted it.');
  els.clear.onclick();
  assert.equal(els.status.textContent, 'Key cleared.');
  assert.equal(server.props.size, 0);
});

test('manifest, menu and source: narrow scopes, one host, real handlers, no logging', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(src, 'appsscript.json'), 'utf8'));
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.deepEqual(manifest.oauthScopes, [
    'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/spreadsheets.currentonly',
    'https://www.googleapis.com/auth/script.container.ui',
  ]);
  assert.deepEqual(manifest.urlFetchWhitelist, ['https://api.oddsrelay.io/']);

  const { ctx, menu } = addon();
  ctx.onOpen();
  assert.deepEqual(menu, ['showSidebar', 'refreshFormulas']);
  menu.forEach((fn) => assert.equal(typeof ctx[fn], 'function'));

  for (const file of ['Logic.js', 'Code.gs', 'Sidebar.html']) {
    const text = fs.readFileSync(path.join(src, file), 'utf8');
    assert.doesNotMatch(text, /console\.|Logger\.|getScriptProperties|getDocumentProperties/, file);
    for (const url of text.match(/https?:\/\/[^\s'"<>)]+/g) || []) {
      assert.match(url, /^https:\/\/(api|app)\.oddsrelay\.io(\/|$)/, `${file}: ${url}`);
    }
  }
});
