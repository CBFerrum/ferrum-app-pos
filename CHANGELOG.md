# Changelog

## 0.2.3

- Selling offline prices as the server does with the platform's newer engine (Ferrum-Frontend
  9ecf5bf, built from Ferrum b5b2d3f, localization.md L0): taxes per unit, reverse charges (shown,
  not charged) and tax rounding per line. The price book carries each item's stock quantity for
  one, so a tax per unit (a deposit per bottle on a six-pack) counts stock units offline too.
- Built with Ferrum-Frontend's current packages: the records frame's pages load when opened, and
  the till's first script stays within the 200 KB budget (192.8 KB).

## 0.2.2

- Installable on its own (Ferrum docs/plan/apps-ui.md §12.5): a till's browser offers to install
  Point of Sale as an app of its own, which opens `/pos/` in its own window with the till's icon,
  beside the workspace's app.

## 0.2.1

- The register's records (lists, forms, reports, apps' screens) load when first opened, so the
  till's first script is 186 KB compressed, within the platform's 200 KB budget (Ferrum
  docs/plan/apps-ui.md §12.9), which the interface's check now enforces. The till itself, and
  selling offline, are unchanged.

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
