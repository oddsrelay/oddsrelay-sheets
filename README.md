# OddsRelay for Google Sheets

Formulas that bring data from the [OddsRelay API](https://oddsrelay.io/docs) into a Google Sheet: matched boards,
sport keys and bookmaker keys. The API serves bookmaker and exchange odds for the UK & Ireland. Each person keeps
their own API key in their own Apps Script settings, never in the spreadsheet.

> **Not yet run in Google.** This first version was written and tested in Node, against the examples in the API
> description, with Google's services stubbed. It has not run in the Apps Script runtime yet. Only a real sheet can
> confirm these parts:
>
> - how `UrlFetchApp` hands back a gzip reply (the script decompresses it only if it still starts with the gzip header)
> - the menu under Extensions, the sidebar and the refresh item
> - the cache (`CacheService`) inside formulas
> - that formulas in a shared spreadsheet read the owner's saved key, as Google's documentation says
>
> If something misbehaves, please report it in this repository's issues.

## Install

### Copy the script into your spreadsheet

1. Open the spreadsheet, then **Extensions > Apps Script**.
2. Rename the project (top left) to **OddsRelay**. The menu takes the project's name.
3. Open **Project Settings** (the gear) and tick **Show "appsscript.json" manifest file in editor**.
4. Back in the **Editor**, replace the contents of `appsscript.json` with [`src/appsscript.json`](src/appsscript.json).
5. Replace the contents of `Code.gs` with [`src/Code.gs`](src/Code.gs).
6. Add a script file (**+ > Script**) named `Logic` and paste in [`src/Logic.js`](src/Logic.js).
7. Add an HTML file (**+ > HTML**) named `Sidebar` and paste in [`src/Sidebar.html`](src/Sidebar.html).
8. Save, reload the spreadsheet, then choose **Extensions > OddsRelay > Set API key**.

The first time, Google asks you to authorise the script for the three permissions listed under
[Permissions](#permissions). The copy is your own unpublished script, so Google may say it has not verified the app:
choose **Advanced**, then go on to OddsRelay.

### Or copy the template

A template spreadsheet with the script already in it skips the steps above: open its link and choose **Make a
copy**. The copy and its script are yours. The template link is added here once it is published.

## Your API key

Sign up at [app.oddsrelay.io](https://app.oddsrelay.io/signup) and copy your key from the dashboard. In the
spreadsheet, choose **Extensions > OddsRelay > Set API key**, paste it and press **Save key**. The add-on checks the
key with one call to `/v2/usage`, which costs no tokens, and does not save a key the API refuses. A browser key is
tied to one website and cannot be used here, so save a server key.

The key is kept in your Apps Script user properties for this script, which only your Google account can read. It is
never written to a cell, the document or a log, it travels only in the `Authorization` header, and the sidebar does
not show it again. **Clear key** removes it.

## Formulas

| Formula | Route | Returns |
|---|---|---|
| `=ODDSRELAY_ODDS(type, sports, bookmakers, exchanges, markets, max_tokens)` | `GET /v2/odds/{type}` | A matched board, one row per back or lay offer |
| `=ODDSRELAY_SPORTS()` | `GET /v2/sports` | Sport and competition keys, and the market keys each one carries |
| `=ODDSRELAY_BOOKMAKERS()` | `GET /v2/bookmakers` | Bookmaker and exchange keys |

Each formula returns a table with a header row, which fills the empty cells below and to its right.

`type` is `standard`, `2up`, `dutching`, `each-way`, `extra-place` or `bog`. The four filters take keys from
`ODDSRELAY_SPORTS` and `ODDSRELAY_BOOKMAKERS`, comma-separated in one string or as a range of cells. Leave a filter
blank (`""`) to skip it. `soccer` is the API's key for football.

```
=ODDSRELAY_ODDS("standard", "soccer_epl", "bet365,ladbrokes", "betfair_exchange", "h2h")
=ODDSRELAY_ODDS("each-way", "horse_racing", A2:A6)
=ODDSRELAY_ODDS("bog", "horse_racing", "", "", "", B1)
```

The last example takes its token cap from cell B1. In locales that write decimals with a comma, Sheets separates arguments with `;` instead.

A board's columns:

| Column | Holds |
|---|---|
| Commence time | The start time as the API sends it: ISO 8601, in UTC |
| Sport, Event | The competition's title; the two sides, or the course for racing |
| Market, Outcome, Line | The market key, the selection, and the line where the market has one |
| Side | `back` or `lay`; for the `each-way` and `extra-place` boards, `lay win` and `lay place` |
| Venue | The bookmaker or exchange key |
| Price, Available | The decimal price; for lay rows, the amount the exchange shows at that price |
| Places, Place fraction | Each-way terms, where the board has them |
| Dutch id | On `dutching`, the legs of one dutch share it |
| Link, Event id | A link to the event on the bookmaker's or exchange's site; the API's event id |

The rows are the API's data as sent. The add-on adds no calculations of its own.

## Tokens

- Every `ODDSRELAY_ODDS` call is quoted first (`quote=true`, which costs no tokens). When the quote is above the
  cap, the cell shows the cost and nothing is fetched. The default cap is small; `max_tokens` sets your own.
- `ODDSRELAY_SPORTS` and `ODDSRELAY_BOOKMAKERS` cost no tokens.
- Replies are kept for about a minute in Apps Script's cache, filed under a hash of your key and the request, so each
  key sees only its own results. A sheet that recalculates does not pay twice for the same call.
- Formulas run again when their arguments change. **Extensions > OddsRelay > Refresh formulas on this sheet** re-runs
  every OddsRelay formula on the sheet, and each one the cache does not answer is a new call.

## When a call fails

The cell shows `#ERROR!`; hover over it for the reason. `IFERROR` works on these cells.

| The cell says | What to do |
|---|---|
| no API key saved | Save one: **Extensions > OddsRelay > Set API key** |
| the API refused this key (with the API's code) | Check the key, then save it again |
| this call would cost ... tokens, above the cap of ... | Narrow the filters, or raise `max_tokens` |
| rate limited. Try again in ... seconds | Wait, then refresh. The add-on waits out one short pause by itself |
| anything else | The API's code and message, with its request id to quote when you contact us |

No message carries your key.

## Sharing a spreadsheet

Google gives formulas the **spreadsheet owner's** saved key, whoever is editing (custom functions can read only the
owner's user properties). So:

- Anyone who can edit a spreadsheet you own can make calls on your key and spend its tokens.
- With the copied script, an editor can also change the script, and so could read your key.
- An editor's own saved key is not used by formulas in a spreadsheet they do not own.

Share view-only, or clear your key before you share. A copy someone makes of your spreadsheet has its own script and
no key until they save theirs.

## Permissions

| Scope | Why |
|---|---|
| `script.external_request` | Calls to `https://api.oddsrelay.io/`, the only address the manifest allows |
| `spreadsheets.currentonly` | The refresh item reads and re-enters formulas in this spreadsheet only |
| `script.container.ui` | The menu and the sidebar |

The add-on sends nothing anywhere else, and keeps nothing but your key and the briefly cached replies.

## Develop

`src/` holds the four Apps Script files. `Logic.js` makes no Google calls. `test/sheets.test.js` runs it together
with `Code.gs` in Node, with Google's services stubbed, on examples from the API description. Node 22 or later, no
dependencies:

```sh
node --test test/sheets.test.js
```

With clasp, use `src/` as the root directory (not tried yet).

## License

MIT
