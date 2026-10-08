// OddsRelay for Google Sheets: the menu, the key sidebar, HTTP, and the sheet formulas.
// The helpers it calls (names ending in "_" without a Google service) are in Logic.js.
//
// The key: each user's own, in that user's Apps Script user properties, set in the sidebar. It goes only into the
// Authorization header. It is never written to a cell, the document, script properties, a log or a message.

const KEY_PROPERTY = 'ODDSRELAY_KEY';
const CACHE_SECONDS = 60;
const CACHE_MAX_CHARS = 100000; // CacheService keeps at most 100 KB under one key
const MAX_RETRY_WAIT_S = 5; // a formula has 30 seconds in all, so only a short Retry-After is waited out
const SPORTS_BUDGET_MS = 20000;

function onOpen() {
  // Runs before the add-on is authorised in this file: only the menu calls are allowed here.
  SpreadsheetApp.getUi().createAddonMenu()
    .addItem('Set API key', 'showSidebar')
    .addItem('Refresh formulas on this sheet', 'refreshFormulas')
    .addToUi();
}

function onInstall(e) {
  onOpen(e);
}

function showSidebar() {
  SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('OddsRelay'));
}

/** Sidebar: checks the key with GET /v2/usage (no tokens), then keeps it in this user's properties. */
function saveKey(value) {
  const key = String(cell_(value)).trim();
  if (!validKey_(key)) return 'That does not look like a key. Paste it again, with no spaces or line breaks.';
  let status;
  let text = '';
  try {
    const res = fetch_(API_BASE + '/v2/usage', key);
    status = res.getResponseCode();
    text = bodyText_(res);
  } catch (e) {
    status = 0;
  }
  if (status === 401) return redact_(errorMessage_(status, text), key);
  PropertiesService.getUserProperties().setProperty(KEY_PROPERTY, key);
  if (status === 200) return 'Key saved. The API accepted it.';
  if (status === 0) return 'Key saved, but the API could not be reached to check it.';
  return 'Key saved, but the check did not finish. ' + redact_(errorMessage_(status, text), key);
}

function clearKey() {
  PropertiesService.getUserProperties().deleteProperty(KEY_PROPERTY);
  return 'Key cleared.';
}

/** Sidebar: whether a key is saved. Never any part of the key itself. */
function keyStatus() {
  return readKey_() ? 'A key is saved.' : 'No key saved yet.';
}

/** Menu: re-enters every OddsRelay formula on the active sheet so Sheets runs it again. */
function refreshFormulas() {
  const range = SpreadsheetApp.getActiveSheet().getDataRange();
  const found = [];
  range.getFormulas().forEach(function (row, r) {
    row.forEach(function (formula, c) {
      if (/ODDSRELAY_/i.test(formula)) found.push({ cell: range.getCell(r + 1, c + 1), formula: formula });
    });
  });
  found.forEach(function (f) { f.cell.clearContent(); });
  SpreadsheetApp.flush();
  found.forEach(function (f) { f.cell.setFormula(f.formula); });
}

/**
 * A matched board as rows, one row per back or lay offer, with a header row.
 * Each call is quoted first (a quote costs no tokens) and refused when the quote is above max_tokens.
 *
 * @param {string} type Board: standard, 2up, dutching, each-way, extra-place or bog.
 * @param {string} sports Sport keys or prefixes, comma-separated or a range (see ODDSRELAY_SPORTS).
 * @param {string} bookmakers Bookmaker keys, comma-separated or a range (see ODDSRELAY_BOOKMAKERS).
 * @param {string} exchanges Exchange keys, comma-separated or a range.
 * @param {string} markets Market keys such as h2h, comma-separated or a range.
 * @param {number} max_tokens Refuse the call when it would cost more tokens than this. Blank for the default.
 * @return Rows with a header.
 * @customfunction
 */
function ODDSRELAY_ODDS(type, sports, bookmakers, exchanges, markets, max_tokens) {
  const req = boardRequest_(type, { sports: sports, bookmakers: bookmakers, exchanges: exchanges, markets: markets });
  return boardRows_(getJson_(req.path, req.params, maxTokensParam_(max_tokens)));
}

/**
 * Sport and competition keys, and the market keys each one carries.
 *
 * @return Rows with a header.
 * @customfunction
 */
function ODDSRELAY_SPORTS() {
  const rows = [SPORTS_HEADER];
  const deadline = Date.now() + SPORTS_BUDGET_MS;
  let cursor = null;
  do {
    const body = getJson_('/v2/sports', cursor ? { cursor: cursor } : {}, null);
    Array.prototype.push.apply(rows, sportsRows_(body));
    cursor = body.meta && body.meta.next_cursor;
  } while (cursor && Date.now() < deadline);
  if (cursor) rows.push(['More rows not shown', '', '', '', '', '']);
  return rows;
}

/**
 * Bookmaker and exchange keys, for the bookmakers and exchanges arguments of ODDSRELAY_ODDS.
 *
 * @return Rows with a header.
 * @customfunction
 */
function ODDSRELAY_BOOKMAKERS() {
  return [BOOKMAKERS_HEADER].concat(bookmakerRows_(getJson_('/v2/bookmakers', {}, null)));
}

// In a formula this is the spreadsheet owner's key: Google gives custom functions the owner's user properties.
function readKey_() {
  return PropertiesService.getUserProperties().getProperty(KEY_PROPERTY) || '';
}

/** GET a route as JSON: cached briefly, and quoted first when cap is a number. */
function getJson_(path, params, cap) {
  const key = readKey_();
  if (!key) throw new Error('OddsRelay: no API key saved. Open Extensions > OddsRelay > Set API key.');
  const values = Object.keys(params).map(function (k) { return String(params[k]); });
  if (values.some(function (v) { return v.indexOf(key) >= 0; })) {
    throw new Error('OddsRelay: a formula argument holds your API key. Take it out of the formula.');
  }
  const url = buildUrl_(path, params);
  // The script cache is shared by everyone using the add-on, so entries are keyed on a hash of key and URL:
  // each key sees only its own results, and the key itself is never stored.
  const cache = CacheService.getScriptCache();
  const id = 'or1:' + hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, key + ' ' + url,
    Utilities.Charset.UTF_8));
  const hit = cache.get(id);
  if (hit) return JSON.parse(hit);
  if (cap !== null) {
    const quote = JSON.parse(request_(buildUrl_(path, Object.assign({}, params, { quote: 'true' })), key));
    const refusal = quoteRefusal_(quote, cap);
    if (refusal) throw new Error(refusal);
  }
  const text = request_(url, key);
  if (text.length <= CACHE_MAX_CHARS) {
    try {
      cache.put(id, text, CACHE_SECONDS);
    } catch (e) {
      // Caching is best effort: a reply over the size limit is just not kept.
    }
  }
  return JSON.parse(text);
}

/** One GET, with one short wait on a 429. Returns the body text of a 200; throws a cell-ready message otherwise. */
function request_(url, key) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = fetch_(url, key);
    } catch (e) {
      throw new Error('OddsRelay: could not reach the API (' + redact_(e && e.message ? e.message : e, key) + ').');
    }
    const status = res.getResponseCode();
    const text = bodyText_(res);
    if (status === 200) return text;
    const wait = Number(headerValue_(res.getHeaders(), 'Retry-After'));
    if (status === 429 && attempt === 1 && wait > 0 && wait <= MAX_RETRY_WAIT_S) {
      Utilities.sleep(wait * 1000);
      continue;
    }
    throw new Error(redact_(errorMessage_(status, text, wait > 0 ? wait : ''), key));
  }
}

function fetch_(url, key) {
  return UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + key, 'Accept-Encoding': 'gzip' },
    muteHttpExceptions: true,
  });
}

// Decompresses when the body still carries the gzip header; text otherwise (UrlFetchApp may have done it already).
function bodyText_(res) {
  if (isGzip_(res.getContent())) {
    return Utilities.ungzip(res.getBlob().setContentType('application/x-gzip')).getDataAsString('UTF-8');
  }
  return res.getContentText('UTF-8');
}
