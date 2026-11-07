# Changelog

## 0.4.11

Rebuilt with Ferrum-Frontend 155518c: the sentences its pages built in code (counts, dates, what a toast or a screen reader says) go through t() too, as whole sentences where code chose a word, and carry built-in Arabic and Hindi (264 words each in ui/src/locales, translated by the model and to be reviewed by native speakers).

## 0.4.10

The assistant knows what its records mean in its pages (contributes.shell.assistant): their states, what counts and where figures come from, with questions it suggests asking there.

## 0.4.9

Rebuilt with Ferrum-Frontend 5b22e7b: its own words carry built-in Arabic and Hindi (253 words each, ui/src/locales, translated by the model and to be reviewed by native speakers), fetched for the page's language only. The labels it keeps in objects, its dialogs, its page titles and the words it keeps in variables go through t() as well, and the names and sizes it shows as they are keep their order right to left. Its pages are drawn once their words are in, and its entry carries only the parts of the kit it uses.

## 0.4.8

Rebuilt with Ferrum-Frontend 6537d65: an action's link, code or token shown once is kept in a dialog to copy, and on a page that reads right to left, English left untranslated keeps its own order. Its own words go through the kit's t() (188 places), so a workspace's own words for its language reach them, and Admin, Interface words lists them under it (dist/words.json).

## 0.4.7

Rebuilt with Ferrum-Frontend d5d98f2: a workspace's own words for its interface (Admin, Interface words) reach its pages as they load; an attachment field that holds a picture shows it; and a value another record already has is said so, where the form said the record had been changed by someone else. Its own screens' margins, paddings, borders, alignment and insets go by the line's start and end, so they mirror right to left as the kit's do; what it places by coordinates (boards, timelines, charts, handles) stays as it was.

## 0.4.6

Rebuilt with Ferrum-Frontend 63280d3: right to left, its pages mirror as they read (icons that point along the line, margins and alignment by the line's start and end, arrow keys along it), and the records pages' words are in Arabic and Hindi.

## 0.4.5

Rebuilt with Ferrum-Frontend a64416a: a new record's box whose default is 1 shows ticked, as it is saved. An action's dialog says every refusal, the errors on what the action made (another record's rows) among them, and an action with parameters and a confirmation asks once.

## 0.4.4

A customer's loyalty balance at the till was added up over one page of their point entries: the till asked for 1,000, the server pages at 500, so a long-standing customer's balance left out entries, earned or spent. The till now reads every page.

## 0.4.3

Rebuilt with Ferrum-Frontend a76295e: its pages show times on a person's own clock when they chose one on their Account page, while today and due dates stay on the workspace's day.

## 0.4.2

A till's sales, held sales, the shift's opening and the X and Z reports are on the workspace's clock. Rebuilt with Ferrum-Frontend 24c3951, so its records' pages show times on the workspace's clock too, a draft numbered on submit is headed as a draft, and a record of an app that is not installed says so.

## 0.4.1

Rebuilt with Ferrum-Frontend bb60115: a record page reads an empty number or check as the server does, so an action whose condition needs one shows, and a workspace's settings open as their one record.

## 0.4.0

The till keeps to the workspace's offline policy (Ferrum docs/offline.md): its price book and what it last knew of the register are kept for the person signed in, under their lease, and forgotten when the lease ends, when someone else signs in on the device, or when they are signed out everywhere; a workspace that keeps nothing on devices sells online only. Queued and held sales are kept until they are sent, whatever the lease says. What was kept before the policy, for anyone on the device, is forgotten once.

## 0.3.3

Rebuilt with Ferrum-Frontend 00dea07: in a workflow state that names what may change, the other fields show read-only, and the fields the state needs show required.

## 0.3.2

Rebuilt with Ferrum-Frontend daeadda: after an action runs, a record page shows what the action said it did rather than only that it is done.

## 0.3.1

Rebuilt with Ferrum-Frontend 80ff179: a field's label names its control for assistive technology, and a record whose title is a link shows that record's title, not its id.

## 0.3.0

The till, rebuilt for a cashier with a queue, and the returns and shift screens it was missing.

- **Faster at the till.** The scan box is always ready: a scanner types into it wherever you last
  tapped, and a code sells at once from the price book kept on the device (the server is asked only
  for a code the book does not know). `3*8901234` sells three. Tiles show their price. The keyboard
  does the rest: F2 scan box, F4 pay, F9 hold, F10 sales on hold, F8 returns, F3 change the picked
  line, arrows to pick a line, + and − for its quantity, Delete to remove it. Buttons are larger on
  touch screens, and a phone keeps the total and Pay at the bottom. The sale on screen comes back
  after a reload.
- **Change a line where it stands.** Quantity, a discount, a price where the register allows it, and a
  note that prints under the line on the receipt. What a cashier may change follows the register's
  switches: the most they may give is shown before they type, and what goes past it is not sent. A
  POS manager has no limit.
- **A new pay window.** Pick a way of paying, type what was handed over and the change shows in large
  type. Add a second way for a split payment: what is still due is already filled in. Card and UPI
  references, selling on account to a named customer, loyalty points with the customer's balance, quick
  cash amounts for the currency's notes, and the rounding the currency needs shown as "rounded from".
- **Hold and resume.** Set a sale aside to serve the next customer, and bring it back from "On hold".
  Held sales are kept on the device, so they work offline.
- **Returns at the till.** Find a sale by receipt number or customer (any cashier's: the customer comes
  to whichever till is free), pick the lines and how many come back, say why, and refund the way it was
  paid: what the customer still owes is cancelled first, points go back as points, and money goes back
  through the ways it came in. What the server would refuse is shown before it does. A copy of the
  original receipt can be printed. Returns need a connection.
- **Opening and closing a shift.** Open with a counted float, note by note if you like. Close on one
  page: for every way of paying, what the register expects, what you counted and the difference (short,
  over or right), a cash counter for notes and coins, the reason when the drawer is not as expected,
  cash put in or taken out during the shift, and the Z report to print. A cashier saves the count and
  a POS manager closes the shift; a manager can do both at once. Closing waits while sales made offline
  are still on the device.
- **Safer when the network drops.** Each sale carries its own id, so one sent twice (the answer was lost
  on the way back) is recognised, not sold twice or left stuck as refused. If the device cannot keep a
  sale (its storage is full or blocked) the till says so instead of clearing the screen. The receipt of
  a sale kept on the device lists its goods (it printed blank lines). After the server fails to answer,
  the till prices from the price book at once instead of waiting for it on every scan.
- **Records.** A return carries its reason (Return Reason, shown in the returns report); a sale line
  carries a note; the Z report names each payment method by its id as well as its name; a sale written
  off by a few cents can be returned whole.
- Fixes: opening a register no longer sends floats for pay-later and points methods, which the server
  refused; the receipt of a sale sent online names its way of paying instead of printing an id.
- Printing is the browser's, as before: this release was not tried on a receipt printer.
- Personal data: a person's request now exports the sessions a cashier ran, and says why they are kept: they are cash records.

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
