// Pure helpers for the OddsRelay Sheets add-on: URLs, the token cap, replies to rows, error text.
// No Google service is used here, so the tests run this file in Node.
// Apps Script shares one global scope across files, so Code.gs calls these directly.
// Names end in "_" so they are private: not callable from a cell or from the sidebar.

const API_BASE = 'https://api.oddsrelay.io';
// The info.version of the OpenAPI file this add-on was written against.
const CONTRACT_VERSION = '2026-07-08';
const BOARD_TYPES = ['standard', '2up', 'dutching', 'each-way', 'extra-place', 'bog', 'two-up', 'each_way', 'extra_place'];
// ponytail: a guess, not measured. The formula's max_tokens argument raises or lowers it.
const DEFAULT_MAX_TOKENS = 500;

const BOARD_HEADER = ['Commence time', 'Sport', 'Event', 'Market', 'Outcome', 'Line', 'Side', 'Venue', 'Price',
  'Available', 'Places', 'Place fraction', 'Dutch id', 'Link', 'Event id'];
const SPORTS_HEADER = ['Key', 'Group', 'Title', 'Active', 'Outrights', 'Markets'];
const BOOKMAKERS_HEADER = ['Key', 'Name', 'Exchange'];

/** A cell value: null and undefined become an empty cell. */
function cell_(value) {
  return value === null || value === undefined ? '' : value;
}

/** "a, b", a number, or a range (a 2D array) to "a,b"; nothing given gives undefined. */
function listParam_(value) {
  const items = [];
  (function walk(v) {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v === null || v === undefined) return;
    String(v).split(',').forEach(function (s) {
      s = s.trim();
      if (s) items.push(s);
    });
  })(value);
  return items.length ? items.join(',') : undefined;
}

/** The path and query for a matched board. Throws on a type the API does not serve. */
function boardRequest_(type, filters) {
  const t = String(cell_(type)).trim().toLowerCase();
  if (BOARD_TYPES.indexOf(t) < 0) {
    throw new Error('OddsRelay: unknown board type. Use standard, 2up, dutching, each-way, extra-place or bog.');
  }
  const params = {};
  ['sports', 'bookmakers', 'exchanges', 'markets'].forEach(function (name) {
    const v = listParam_(filters[name]);
    if (v) params[name] = v;
  });
  return { path: '/v2/odds/' + t, params: params };
}

/** The token cap for one formula: blank means the default. */
function maxTokensParam_(value) {
  if (value === '' || value === null || value === undefined) return DEFAULT_MAX_TOKENS;
  const n = Number(value);
  if (!isFinite(n) || n < 0) throw new Error('OddsRelay: max_tokens must be a number, 0 or more.');
  return n;
}

function buildUrl_(path, params) {
  const query = Object.keys(params || {})
    .filter(function (k) { return params[k] !== undefined && params[k] !== ''; })
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
    .join('&');
  return API_BASE + path + (query ? '?' + query : '');
}

/** Why a quoted call must not be made, or null when it fits under the cap. */
function quoteRefusal_(quote, cap) {
  const cost = quote && quote.cost;
  if (typeof cost !== 'number') return 'OddsRelay: the quote came back without a cost, so nothing was fetched.';
  if (cost > cap) {
    return 'OddsRelay: this call would cost ' + cost + ' tokens, above the cap of ' + cap +
      '. Narrow sports, bookmakers or markets, or raise max_tokens.';
  }
  return null;
}

/** A matched board (envelope or bare) to rows under BOARD_HEADER: one row per back or lay offer. */
function boardRows_(body) {
  const events = Array.isArray(body) ? body : (body && body.data) || [];
  const rows = [BOARD_HEADER];
  events.forEach(function (ev) {
    const name = ev.home_team && ev.away_team ? ev.home_team + ' v ' + ev.away_team : ev.event_name || ev.venue;
    (ev.markets || []).forEach(function (market) {
      (market.outcomes || []).forEach(function (o) {
        function add(side, x) {
          rows.push([ev.commence_time, ev.sport_title, name, market.key, o.name, o.point, side,
            x.bookmaker || x.exchange, x.price, x.available, x.places, x.place_fraction, x.dutch_id, x.link,
            ev.event_id].map(cell_));
        }
        (o.back || []).forEach(function (x) { add('back', x); });
        const lay = o.lay;
        if (Array.isArray(lay)) {
          lay.forEach(function (x) { add('lay', x); });
        } else if (lay) {
          (lay.win || []).forEach(function (x) { add('lay win', x); });
          (lay.place || []).forEach(function (x) { add('lay place', x); });
        }
      });
    });
  });
  return rows;
}

/** One page of /v2/sports to rows under SPORTS_HEADER (no header). */
function sportsRows_(body) {
  return ((body && body.data) || []).map(function (s) {
    return [s.key, s.group, s.title, s.active, s.has_outrights, (s.markets || []).join(',')].map(cell_);
  });
}

/** /v2/bookmakers to rows under BOOKMAKERS_HEADER (no header). */
function bookmakerRows_(body) {
  return ((body && body.data) || []).map(function (b) {
    return [b.key, b.name, b.is_exchange].map(cell_);
  });
}

/** A header's value, whatever case the runtime gives its name. */
function headerValue_(headers, name) {
  const wanted = name.toLowerCase();
  const found = Object.keys(headers || {}).filter(function (k) { return k.toLowerCase() === wanted; })[0];
  return found === undefined ? '' : String(headers[found]);
}

/** The text a cell shows for a failed call. The caller removes the key from it. */
function errorMessage_(status, text, retryAfter) {
  let err = {};
  try {
    const body = JSON.parse(text);
    if (body && body.error) err = body.error;
  } catch (e) {
    // An empty or non-JSON body (the front door's own 429 and 502) keeps the status alone.
  }
  const code = err.code || 'http_' + status;
  if (status === 401) {
    return 'OddsRelay: the API refused this key (' + code + '). Check it in Extensions > OddsRelay > Set API key.';
  }
  if (status === 429) {
    return 'OddsRelay: rate limited. Try again in ' + (retryAfter || 'a few') + ' seconds.';
  }
  return 'OddsRelay: ' + code + (err.message ? ': ' + err.message : '') +
    (err.request_id ? ' (request ' + err.request_id + ')' : '');
}

/** True when bytes (signed, as Apps Script gives them, or not) start with the gzip header. */
function isGzip_(bytes) {
  return bytes.length > 1 && (bytes[0] & 0xff) === 0x1f && (bytes[1] & 0xff) === 0x8b;
}

/** Text with every copy of the key replaced. */
function redact_(text, key) {
  return key ? String(text).split(key).join('[hidden]') : String(text);
}

/** A key an HTTP header can carry: printable ASCII, no spaces. */
function validKey_(key) {
  return /^[\x21-\x7e]+$/.test(key);
}
