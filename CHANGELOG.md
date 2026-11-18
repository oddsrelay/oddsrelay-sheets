# Changelog

## Unreleased

- `ODDSRELAY_ODDS` names `region=uk` on every call: the matched boards are served for the UK & Ireland only, and an
  account whose home region is another one is refused when no region is sent.
- `ODDSRELAY_SPORTS` and `ODDSRELAY_BOOKMAKERS` take an optional region code, to list another region's keys.
- README: the API serves 20 more regions; these formulas read the matched boards. No raw odds formula yet.

## 0.1.0 (unreleased)

The first version. Tested in Node with Google's services stubbed; not yet run in Google.

- `ODDSRELAY_ODDS`, `ODDSRELAY_SPORTS` and `ODDSRELAY_BOOKMAKERS`, following API description version 2026-07-08.
- A sidebar to save and clear your own key. It is checked against `/v2/usage` first, and a key the API refuses is
  not kept. A saved key lives in your Apps Script user properties.
- Board calls are quoted first and refused above a cap; replies are cached briefly, per key.
- Gzip is asked for and decoded; one short `Retry-After` is waited out; error cells never carry the key.
- A menu item re-runs the OddsRelay formulas on the active sheet.
