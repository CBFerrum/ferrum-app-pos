# Changelog

## 0.6.0

What a business varies at the till, server side (the till's screens follow in a later version; the till of 0.5.2 keeps working, and what it already sends is checked as before).

- **Limits by role** (`PosRoleLimit`): the largest discount by percent and per sale in money, price changes, voiding a line and a sale, the largest refund, returns without a receipt, opening the drawer without a sale, reprints; per role, a register's own row before the row for every register, the most generous of a person's roles applying; a second row for the same role and register (or for every register) is refused when saved. A person none of whose roles has a row keeps the register's discount and price settings (a POS Manager, no limit), so nothing changes on upgrade. `GET /api/app/pos/limits?profile=` gives the till the same record to check before it asks.
- **Approval by another person's PIN** (`POST /pin`, `POST /approve`): a manager, or anyone whose limits allow it, approves one act on the cashier's till without the cashier signing out. The PIN is kept only as an argon2id hash, five wrong tries lock it for fifteen minutes, and it never reaches a record, a log or an action's audited parameters. The approval (`PosApproval`: who asked, who approved, what, how much, why, the approver's limits then) is for one sale or draft (`sale`: the id the till gives it; none only for opening the drawer) and one act, covers at most the amount approved (a sale changed beyond it needs a new one), is used once, and lapses after the register's Approval Lasts (Minutes) (5 by default) or when the cashier's session closes, which is what handing the till over is. Offline there is no approval: a short PIN cannot be checked on the device without giving it away, so an act beyond the cashier's own limits waits for the connection.
- **Voids with reasons** (`PosReason`, seeded): lines taken off before payment are sent in `voided_lines` with a reason; a sale not yet closed is voided by the `void` action with a reason, by someone who may or with an approval, and keeps who and why.
- **Stored value at the till**, through ERP 0.20's stored value: a gift card or store credit sold or topped up on a line (by its code), taken as a tender in whole or in part (by its code and PIN; `POST /balance` tells the balance, state and expiry first), refunded onto on a return. Such a sale is invoiced when it is submitted (`invoiced_at_sale`), so a card sold at ten is spendable at eleven; the closing only settles it. A card's part of a sale goes back only onto stored value; cash may go back as store credit. Codes are kept as their last four characters (and ERP's hash). Offline, a stored value payment method is refused unless it states an amount it may take offline (`offline_limit`); what the card no longer holds when the sale arrives is written off on the sale and recorded as a shortfall (`PosStockShortfall.amount_short`).
- **Invoice now**: a sale marked `invoice_now` gets its own sales invoice at once and is not invoiced again at closing.
- **Return policy** (`PosReturnPolicy`, named on the register; none keeps returns as they were): the days a sale is taken back within (30), what a return without a receipt comes back at (today's price; or the lowest the register sold it for over a stated window; or typed by the cashier within their refund limit), what it is refunded to (store credit through ERP's stored value by default, or the methods listed), restocking fees by condition, and the clearing method exchanges go through. The register names its damaged and scrap warehouses; each returned line's condition (Resaleable by default) chooses where it goes and its fee.
- **Returns without a receipt** (`without_receipt`): by customer or walk-in, item by item at the policy's price, with one of the business's return reasons, by someone who may or with an approval, refunded as the policy says within the refund limit or approved; their credit note is made at once. Refused offline: the price, approvals and store credit are the server's.
- **Exchanges** (`POST /exchange` `{back, out}`): one transaction of a return (with or without its receipt) and a sale, linked by `exchange`, each priced, taxed and moving stock on its own; what comes back pays for what goes out through the policy's clearing method (netting to nothing at closing), and the customer pays the rest or is refunded it by the return's own rules. Online only. The prices, fees and split are in the pure engine (`logic.rs`).
- **Codes and PINs at rest**: a test searches every table after a card with a PIN is sold, asked about and paid with, and a staff PIN approves: neither a staff PIN nor a card's code or PIN is stored anywhere. Built against ERP 0.20.1.

What the till's screens need (they follow in a later version): role limits from `GET /limits` before asking; the approval dialog (approver, PIN, reason) sending the sale's own id; voided lines with a reason; a card's code and PIN fields on a card line and a card tender, and `POST /balance`; Invoice Now; on returns, a Without a Receipt switch, the return reason, each line's condition and, where the policy says so, its typed price; the exchange screen (what comes back, what goes out, the difference to pay or refund); the policy's price, fee and window mirrored from `logic.rs` for showing totals before saving.

Not in this version: the rule to invoice a buyer with a tax registration at once and the receipt's tax by rate and both parties' registrations (PS-54, PS-55: ERP's localization seam exposes no buyer's registration yet), and reprints marked as copies with their log, the reprint limit and the drawer opened without a sale (PS-53).

## 0.5.2

Rebuilt with Ferrum-Frontend 45dad7f, the design system as tuned after the landed build was reviewed. The left menu's icons are chosen so that none repeats on more than three rows and each fits its row; their drawings load beside the first page instead of inside it, so the page starts lighter; a row that scrolls sideways fades at the edge where there is more, in every browser and with reduced motion; a printed record leaves out empty fields and keeps its totals with the table; menus and popovers sit inside the page's landmarks for assistive technology; a selection bar folds what does not fit into More on a narrow screen. Nothing else changes.

## 0.5.1

The interface follows the upgraded design system, rebuilt with Ferrum-Frontend 0a47157. Text uses the kit's type roles (nothing under 12px) and controls its height tokens; loading shows skeletons shaped like what is coming; empty, no matches, denied, offline and failed are told apart; status colours come from stored state ids. The interface check now runs the UI lint against an empty baseline. Every key on the till and in the payment dialog is at least 44px (the old touch minimum rendered at 42), and a sale kept on the device is never shown as saved.

## 0.5.0

Two tills offline that sell the last of something: what happens when the second sale arrives is the register's declared policy, and nothing is lost or unexplained (Ferrum's closure review, FEO-026).

- A sale the till kept while it could not reach the server is sent marked Sold Offline.
- When it arrives and takes more than the warehouse holds, the register's Sold Offline Beyond Stock decides: Record and reconcile (the default: the customer paid and took the goods, so the sale is recorded, the warehouse shows what left it, and a Stock Shortfall per item says how much was not there, from which sale, until a manager marks it put right and says how), or Refuse, as an online sale is. Before, such a sale was refused, and the till could only retry it or discard a sale that had happened.
- Sent again after its answer was lost, a sale is recorded once, as before (its key).

## 0.4.13

The reports it defines in code (their titles and parameters) have names in Arabic and Hindi too, with its models' and manifest's (272 each in ui/src/locales/names). Translated by the model, to be reviewed by native speakers.

## 0.4.12

Rebuilt with Ferrum-Frontend c59c9a2: the names of its models, fields and manifest in Arabic and Hindi (267 each in ui/src/locales/names, which the platform serves to every page of the workspace, so a record's labels, the launcher and the bar read in the person's language), and the sentences its pages still showed in English (split around a link or a figure, built in code from a template or word by word) whole and translated (300 words each in ui/src/locales). Translated by the model, to be reviewed by native speakers.

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
