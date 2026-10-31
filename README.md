# Ferrum Point of Sale

A native app for [Ferrum](https://github.com/CBFerrum/Ferrum), the open-source, AI-first ERP.

- Register profiles, cashier sessions with opening balances, cash in and out
- A full-screen till at `/pos/` that keeps selling offline: its own worker opens it without a
  connection, a price book on the device prices sales with the server's own engine (WebAssembly),
  and sales it could not send go when the connection, or the cashier's session, is back
- Offline-safe sales (client-generated ids, idempotent replays), split payments, change, discounts within limits
- Barcode lookup in one query, returns against the original sale
- Closing that consolidates sales into invoices and payments per method, with cash differences booked
- Loyalty programs with a points ledger; seven reports including the X/Z report
- packages/pos/README.md documents the API sequence a POS client follows

## Install

Workspace administrators install it from **Apps** in Ferrum; it ships in the official Ferrum
server image. Self-hosters building their own image enable the `pos` feature of the server.
Everything it adds is also available to AI agents over Ferrum's MCP server.

## Develop

Clone it next to the platform and point the platform dependencies at your checkout (this file
is git-ignored):

```toml
# .cargo/config.toml
[patch."https://github.com/CBFerrum/Ferrum"]
ferrum-kernel = { path = "../ferrum/crates/kernel" }
ferrum-meta = { path = "../ferrum/crates/meta" }
ferrum-domain = { path = "../ferrum/crates/domain" }
ferrum-calc = { path = "../ferrum/crates/calc" }
```

The tests need PostgreSQL with an ordinary (non-superuser) role — row-level security must apply:

```bash
createuser ferrum --pwprompt && createdb -O ferrum ferrum_pos_test
```

```bash
cargo test
```

`FERRUM_POS_TEST_DATABASE_URL` overrides the database URL. The app's metadata lives in `packages/` and is embedded
at build time; `app.yaml` is its manifest (see Ferrum's `docs/plan/apps.md`).

The interface is `ui/`, built with Ferrum-Frontend's packages from a sibling checkout
(`../ferrum/web`); its built files, `ui/dist`, are committed and embedded in the crate:

```bash
cd ui && npm run build && npm test && npm run check
```

`ui/public/sw.js` is the till's own worker (served at `/pos/sw.js`); the till's offline parts are
`ui/src/lib/offline.ts` (price book, pricing, what the till last knew) and `ui/src/lib/pos.ts` (the
cart and the outbox of sales not yet sent).

## License

AGPL-3.0-only, like the platform.
