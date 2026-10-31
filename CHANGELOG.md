# Changelog

## 0.2.0

- Its own interface at `/pos/` (Ferrum docs/plan/apps-ui.md §13): the till, full screen, and the
  register's records (profiles, sessions, sales, closings, loyalty) in the records frame. The till
  moved here from Ferrum-Frontend.
- Sells offline. Its own worker (`/pos/sw.js`) keeps the till's page and files, so it opens
  without a connection; `GET /api/app/pos/pricebook` gives a register's price book, which the till
  keeps on the device and prices sales from with the server's own engine (`@ferrum/calc`, Ferrum's
  crates/calc in WebAssembly), searching and scanning from it too. Sales it cannot send wait on the
  device with who made them and when, and go when the connection, or the person's session, is
  back; the server prices each again, and one whose payments no longer cover it waits for a person.

## 0.1.1

- Requires the ERP app (Ferrum docs/plan/apps-ui.md §13): installing it in a workspace without ERP
  installs ERP whole, with its interface, rather than a few of its packages.

## 0.1.0

- First release as a standalone Ferrum app (previously part of the Ferrum repository).
