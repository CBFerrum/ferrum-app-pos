<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
  <img alt="Ferrum Point of Sale: a till that keeps selling offline and closes into your books" src="docs/assets/banner-light.svg" width="100%">
</picture>

<br>

[![Version](https://img.shields.io/badge/version-0.7.4-ea580c?style=flat-square)](CHANGELOG.md)
[![Licence: AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-blue?style=flat-square)](LICENSE)
[![Ferrum platform](https://img.shields.io/badge/runs%20on-Ferrum-2f5bea?style=flat-square)](https://github.com/CBFerrum/Ferrum)
![Rust](https://img.shields.io/badge/Rust-server-b7410e?style=flat-square&logo=rust)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-data-336791?style=flat-square&logo=postgresql&logoColor=white)
![React](https://img.shields.io/badge/React-TypeScript-087ea4?style=flat-square&logo=react&logoColor=white)
![WebAssembly](https://img.shields.io/badge/WebAssembly-pricing-654ff0?style=flat-square&logo=webassembly&logoColor=white)
![Tests](https://img.shields.io/badge/tests-18%20Rust%20%C2%B7%20153%20UI-16a34a?style=flat-square)

### A till that keeps selling when the network drops, and closes into your books when the shift ends.

Ferrum Point of Sale is for shops, counters and pop-ups that sell over a counter. The till runs full screen in a browser, installs as an app, and prices every sale with ERP's own pricing engine, so offline totals are the server's totals. It replaces Square POS, Shopify POS, Lightspeed Retail or Odoo POS when you want the sales, the stock and the cash in the same self-hosted books.

[💡 Why](#-why-point-of-sale) · [📸 Screenshots](#-screenshots) · [✨ Features](#-features) · [📊 Compare](#-how-it-compares) · [📍 Roadmap](#-roadmap) · [🚀 Install](#-install) · [🔧 Develop](#-develop)

</div>

## 💡 Why Point of Sale

- 📴 **It sells offline.** The till's page, files and price book stay on the device. Sales wait in a queue with who made them and go when the connection, or the cashier's session, is back.
- 🧮 **One pricing engine.** ERP's pricing code is compiled to WebAssembly and runs in the till, so prices, promotions and taxes offline match what the server prices again on arrival.
- 🧾 **It closes into the books.** Closing a shift consolidates the sales into ERP sales invoices and credit notes, with one settlement entry, cash differences booked and every total checked to the unit.
- 🛡️ **Control without friction.** Limits by role, approvals by another person's PIN without signing out, voids with reasons, a log of every reprint, and blind cash counts.
- ↩️ **Returns that follow the money.** With or without a receipt, exchanges as one transaction, refunds through the way the sale was paid, and a return policy per register.
- 🎁 **Gift cards, store credit and loyalty** are built in, through ERP's stored value and the app's points ledger with tiers and expiry.
- 🏠 **Self-hosted and open source.** AGPL-3.0, your server and your data, with no per-register fee.
- 🧩 **Extendable in Studio, open to AI agents.** Add fields to any record, and use the same records over REST and MCP under the same permissions.

## 🎯 At a glance

| | |
|---|---|
| **Version** | 0.7.4 |
| **Kind** | Its own interface at `/pos/`: the till, full screen, installable and working offline, plus its own screens for returns, the shift and the manager's lists. Records open in the platform's records screens |
| **What it adds** | 30 entities (15 you work with, 15 that sit inside them), 2 roles, 7 reports and an item lookup for the till, 5 document templates (receipt, gift receipt, receipt message, shift report, cash slip), 1 menu module, 3 database migrations |
| **Depends on** | Ferrum platform `>=0.3.1, <0.4` and [ERP](https://github.com/CBFerrum/ferrum-app-erp) `>=0.26` (installing Point of Sale installs ERP) |
| **Works with** | ERP (items, prices, promotions, stored value, invoices, stock), [Retail](https://github.com/CBFerrum/ferrum-app-retail) (goods sold at a till can be returned at any store), Mail and messages (receipts by message) |
| **Languages** | English, Arabic (right to left), Hindi |
| **Tests** | 18 Rust tests, 153 interface tests |
| **Licence** | AGPL-3.0-only |

## 📸 Screenshots

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/pos-till-dark.webp"><img alt="Point of Sale — till" src="docs/assets/screens/pos-till-light.webp"></picture><br><b>🛒 The till</b><br><sub>Scan or tap items to sell them, then take payment, full screen and working offline.</sub></p>

<table>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/pos-till-cart-dark.webp"><img alt="Point of Sale — items in the cart" src="docs/assets/screens/pos-till-cart-light.webp"></picture>
<p><b>🧾 Items in the cart</b><br><sub>Change a quantity on the line, see subtotal, tax and total, then press Pay, Hold or Clear.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/pos-till-pay-dark.webp"><img alt="💳 Taking payment" src="docs/assets/screens/pos-till-pay-light.webp"></picture>
<p><b>💳 Taking payment</b><br><sub>Pick how the customer pays, use a quick amount, and see the change before completing the sale.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/pos-shift-dark.webp"><img alt="🧮 Closing the shift" src="docs/assets/screens/pos-shift-light.webp"></picture>
<p><b>🧮 Closing the shift</b><br><sub>Count the drawer per way of paying (or note by note), see what the till expects, print the X report and close.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/pos-invoice-list-dark.webp"><img alt="📃 POS invoices" src="docs/assets/screens/pos-invoice-list-light.webp"></picture>
<p><b>📃 POS invoices</b><br><sub>Every sale from every register, with its payments, returns and status.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/pos-profile-list-dark.webp"><img alt="⚙️ POS profiles" src="docs/assets/screens/pos-profile-list-light.webp"></picture>
<p><b>⚙️ POS profiles</b><br><sub>Set up each register: warehouse, price list, ways of paying and who may use it.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/pos-report-takings-dark.webp"><img alt="POS takings by session, cashier and way of paying" src="docs/assets/screens/pos-report-takings-light.webp"></picture>
<p><b>📊 Takings by session, cashier and way of paying</b><br><sub>What each session and cashier took, split by way of paying, for any period.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/pos-report-top-items-dark.webp"><img alt="POS top selling items" src="docs/assets/screens/pos-report-top-items-light.webp"></picture>
<p><b>🏆 Top selling items</b><br><sub>The items that sold most over a period, by quantity and value.</sub></p>
</td>
<td width="50%"></td>
</tr>
</table>

<p align="center">
<span><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/pos-till-phone-dark.webp"><img alt="Point of Sale — till" src="docs/assets/screens/pos-till-phone-light.webp" width="260"></picture><br><sub><b>🛒 The till on a phone</b></sub></span>&nbsp;
</p>

## ✨ Features

### 🧰 Registers

- **POS Profile.** A register (or a group of registers) with its company, warehouse, price list, currency, default customer, tax template and cost center. Stock leaves, and returns come back to, the register's warehouse.
- **Numbering.** Invoice numbers are `PREFIX-fiscal year-000001`, gapless per prefix. Give each register its own prefix.
- **Payment methods per register.** Cash, Bank (card, UPI, wallet), General, Credit, Loyalty Points and Stored Value, each with its account. Modes of payment are ERP's, with a type at the till.
- **Who may sell.** Allowed users per register, or anyone with the Cashier role. The register can show only some item groups and allow only some customer groups.
- **Rules.** Discounts and price changes on or off with a maximum discount, a write-off limit for small unpaid differences, a cash difference account, a safe account, and whether negative stock is allowed.
- **Receipts.** The paper (Thermal 80 mm, Thermal 58 mm or A4), a header and a footer.
- **Seeded defaults.** A Walk-in Customer and the modes Cash, Card, UPI, Wallet, Credit and Loyalty Points.

### 🕐 Sessions and shifts

- **Open a shift** with a counted float, note by note if you like. A cashier has one open session per register.
- **Closing** is one page: for every way of paying, what the register expects, what you counted and the difference, a cash counter for notes and coins, the reason when the drawer is off, cash moved during the shift, and the Z report to print.
- **A cashier saves the count and a manager closes the shift,** or one person with both rights does both. Closing waits while sales made offline are still on the device.
- **Blind close.** A register can hide what each method was expected to hold until it is counted, and every method must be counted to close. Nothing a cashier can read gives an expected figure before then, and the cashier's reports leave out the sales of sessions still open.
- **X report** while the session is open, **Z report** once it is closed.

### 🛒 The till

- **A scan box that is always ready.** A scanner types into it wherever you last tapped, and a code sells at once from the price book on the device. `3*8901234` sells three. Pack barcodes and an item's extra barcodes scan too.
- **Search and tiles.** Search items by name or code, or tap a tile with its price.
- **Change a line where it stands.** Quantity, a discount, a price where the register allows it, and a note that prints under the line. What a cashier may change follows their limits, shown before they type.
- **The keyboard does the rest.** F2 scan box, F4 pay, F9 hold, F10 sales on hold, F8 returns, F3 change the picked line, arrows to pick a line, + and − for its quantity, Delete to remove it.
- **Sales on hold.** Set a sale aside to serve the next customer and bring it back from On hold. Held sales are kept on the device, per register and cashier, so they work offline, and a resumed sale is priced again.
- **Customer.** Pick or search a customer, or sell to the walk-in customer. A register with no default customer asks for one.
- **The sale survives a reload.** The sale on screen comes back after a reload, and a phone keeps the total and Pay at the bottom.
- **Touch first.** Every key is at least 44 px.

### 🧮 Pricing, promotions and tax

- **ERP's pricing, once.** Prices, discounts, pricing rules, promotions and tax come from ERP's pricing crate. The server uses it, and the till runs the same code as WebAssembly (about 650 KB, fetched only when a sale is priced offline and kept by the worker).
- **Promotions at the till.** A sale takes ERP's promotions for the Point of Sale channel, with a code box. Each promotion's share of each line and the free items it adds are kept, its use is counted once when the sale is submitted, and given back on cancellation.
- **Tax by rate.** The totals show tax by rate when more than one rate is charged.
- **A returned line gives back the share of promotion** its original line took.
- **Rounding.** Cash rounding follows the company's rounding step and is shown as "rounded from".

### 💳 Payment

- **A pay window.** Pick a way of paying, type what was handed over, and the change shows in large type. Add a second way for a split payment: what is still due is already filled in. Quick cash amounts match the currency's notes.
- **Change comes only out of cash.** Card, UPI and points cannot exceed what is due. A shortfall up to the register's write-off limit is written off.
- **On account.** Credit sells to a named customer who pays later, within their credit limit, which counts the register's unclosed sales.
- **Loyalty points** as a way of paying, with the customer's balance shown.
- **Stored value.** A gift card or store credit taken in whole or in part, after its balance, state and expiry are read. The code and PIN go in boxes, are sent in the one request and are never kept anywhere.
- **Invoice now.** A switch on the payment step for a sale that should get its own sales invoice at once.
- **A buyer's tax registration.** The buyer can give a tax registration number and name. The customer holding the number is found, or made (the register's choice: Find or Create, or Find Only), in a group you name. Which fields hold a registration, and which numbers are valid for a business, come from the installed country add-ons: this app knows no country.
- **Tax invoice at the sale.** A registered buyer can get their own sales invoice when the sale is made, or be invoiced with the others at closing. A sale above a limit needs a named buyer.

### 📴 Working offline

- **The till opens without a connection.** Its own worker keeps the till's page, the files it loads and the pricing engine, and answers from them only when the network cannot.
- **A signed, versioned snapshot** of the register's price book (prices, taxes, promotions for the next 14 days, the buyer rule, items with their code, name, barcode and group) is kept on the device and fetched again when it is half an hour old.
- **Sales wait with who made them.** Each sale has its own id, so one sent twice (the answer was lost) is recorded once. A sale that cannot be kept (storage full) is said, not cleared.
- **Offline sales are priced again on arrival** with the snapshot they named. If the till's total, the snapshot's and the recorded one are not all equal, a **Price Difference** is recorded for a manager. The sale stands as the buyer paid it.
- **Sold beyond the stock.** The register decides: **Record and reconcile** (the customer paid and took the goods, so the sale is recorded and a **Stock Shortfall** per item waits for a manager to put right) or **Refuse**. A stored-value card taken offline up to a limit that the card no longer held is a shortfall too.
- **Needs the connection:** returns, approvals by PIN, card balance, receipts from the server and customer search. The till says so plainly.

### ↩️ Returns and exchanges

- **Find the sale.** Scan a receipt (or type it whole, then Enter), or search by receipt number or customer, at any till: the customer takes the receipt to whichever is free. A sale says until when it comes back.
- **Pick lines and quantities.** The desk shows what each is worth and what would be refused before it is.
- **The server plans the refund.** What the customer still owes on the sale is cancelled first, points go back as points, and money goes back through the ways the sale was paid where the register allows. What no method can take goes onto store credit or out as cash, as the policy says.
- **Return without a receipt.** By customer or walk-in, item by item, with the condition of each (which decides the warehouse and the restocking fee), priced by the policy, and refunded as the policy allows, store credit by default.
- **Exchanges.** What comes back and what goes out are one transaction with one difference to pay or refund. Each side is priced, taxed and moves stock on its own.
- **Return policy** (per register): the days a sale is taken back within, the price of a return without a receipt (current price, the lowest in a window, or entered), restocking fees by condition, the refund methods and how an exchange clears. The register names where damaged and scrapped goods go.
- **Two tills at once.** The sale is locked while a return is checked, so two tills returning the same line are told nothing is left.
- **Goods return at the cost they left at.** Earned points are taken back pro rata.

### 🛡️ Limits, approvals and voids

- **Limits by role** (POS Role Limit): the largest discount in percent and in money, price changes, voiding a line and a sale, the largest refund, returns without a receipt, opening the drawer without a sale, and reprints. A person with several roles gets the most generous. A row can name one register.
- **Approval by another person's PIN.** Over a limit, the till asks another person (their email and PIN) to approve one act on this sale, without the cashier signing out. An approval is used once, lapses after a number of minutes and when the session closes, and is recorded with the approver's limits. The PIN is kept only as an argon2id hash and locks after five wrong tries.
- **Voids with a reason.** Taking a line off after it was rung asks for a reason from the business's list, and a sale not yet closed is voided from its receipt with a reason. Who voided and why is kept.
- **Reasons** (POS Reason) for voids, returns, opening the drawer without a sale and reprints are the business's own list.
- **Set my PIN** is one menu away.
- **Managers** may exceed cashier limits and act in any session.

### 🧾 Receipts

- **Documents the workspace edits.** The receipt, the gift receipt, the receipt message, the shift report and the cash slip are document templates under Settings. The receipt shows the seller's and buyer's registrations, the tax by rate, prices with or without tax, rounding, each tender with change, what is left on a gift card (never its code), the promotions taken, the register's header and footer, and a Code 128 barcode of the receipt number for returns.
- **The first printing is given once.** The server hands out the first printing once, with an atomic mark under the sale's lock. A copy says COPY n and is counted.
- **Copies and gift receipts.** A copy needs a reason where the business has some, and another person's approval where the cashier may not reprint. A gift receipt has no prices.
- **Receipts by message.** Send a receipt to an address or number with the buyer's consent (this receipt only, or this and later ones). An opt-in puts the address on a named customer's record when it has none.
- **A log of every reprint** (Receipt Event): who, when, why and by whose approval.
- **Printing is the browser's print dialog.** There is no direct printer or cash drawer support yet.

### 💵 Cash management

- **Paid in and paid out** with an account, a cost center and a reason.
- **Safe drop** to the register's safe account, never more than the drawer holds.
- **Slips.** Each movement prints its cash slip.
- **Counting.** A counter for notes and coins by denomination, a difference per method, and over and short booked to the cash difference account.

### 🎁 Loyalty

- **Loyalty program.** A conversion factor (the value of a point), tiers by lifetime spend with the amount spent per point, an expiry in days, an expense account, customer groups and dates.
- **Earned on submit** at the customer's tier, not on what points paid for. The walk-in customer never collects.
- **Redeemed soonest-expiring first.** Returns and cancellations take points back, or give redeemed ones back.
- **Expiry** runs every minute.
- **A ledger.** Loyalty Point Entry is the read-only points ledger.

### 🏦 Closing into the books

- **On sale:** stock leaves the register's warehouse with its valuation entry (cost of goods sold against stock), as a delivery note would.
- **On closing:** paid sales become one sales invoice per customer. A sale with a credit part gets its own invoice, so each unpaid sale is a separate receivable with its due date. Returns become one credit note per customer and original invoice and never move stock again.
- **Exact.** Taxes are the POS taxes as fixed amounts and cash rounding is carried as an amount, so every consolidated total equals its POS invoices. A mismatch refuses the closing.
- **One settlement entry** debits each payment method's account (cash net of change), the loyalty expense for redeemed points and the write-off account, and credits the receivable.
- **Cancelling a closing** reverses the settlement, cancels its invoices and credit notes, returns the sales to Paid, Unpaid or Return and reopens the session. It is refused when later credit notes, payments or returns depend on it.
- **A POS invoice can be voided** only before its session closes. Afterwards, make a return.

### 📊 Reports

| Report | What it shows |
|---|---|
| **POS Sales Summary** | Takings per session, cashier and payment method, net of change and refunds, with the session's reconciliation (the X report while open, the Z report once closed) |
| **POS Daily Sales** | By item or item group: quantity, net and tax share |
| **POS Payment Reconciliation** | Expected against counted per closing |
| **POS Top Items** | The best sellers |
| **POS Hourly Sales** | Sales by hour |
| **POS Returns** | Returns with their reasons |
| **POS Shift Report** | A closing with paid in, paid out, safe drops, refunds and tax by rate |

A cashier who reads only their own sales sees only their own figures.

### 👀 For managers

- **Stock Shortfalls.** A list of stock a till sold offline beyond what the warehouse held, with the sale, and how it was put right.
- **Price Differences.** A review screen of offline sales that the server priced differently, with the three totals, and a note of what was found and done.
- **Approvals and receipt events** as records, read-only.

### 🔐 Roles, privacy and APIs

- **Two roles,** below. Row-level security applies to every table.
- **Personal data.** A request exports the sessions a cashier ran and says why they are kept (they are cash records). A buyer's name and registration on their sales are erased and the sales stay.
- **Records for free.** Lists, forms, search, exports, audit trail, REST and MCP. The till's own server routes (price book, snapshot, limits, approvals, balance, receipts, returns, exchange) are under `/api/app/pos/`.
- **The assistant** knows what the records mean and suggests questions such as what each register sold today and which sessions are still open.

### 🌍 Languages

- **English, Arabic and Hindi** for the app's words and the names of its records. Pages mirror right to left. The Arabic and Hindi text was translated by a model and is waiting for review by native speakers.

## 🧭 How it works

```mermaid
flowchart LR
    SC["Scan or tap"] --> PR["Price with ERP's engine"]
    PR --> PAY["Take payment"]
    PAY -->|"online"| SRV["Server prices again and books"]
    PAY -->|"offline"| Q["Queue on the device"]
    Q -->|"connection back"| SRV
    SRV --> SH["Shift"]
    SH --> CL["Closing"]
    CL --> INV["ERP invoices, credit notes, settlement"]
```

Online or offline, the till prices with the same code. An offline sale is priced again on arrival with the snapshot it named, and a different total waits for a person.

```mermaid
flowchart LR
    CASH["Cashier asks for something over a limit"] --> ASK["Another person's PIN"]
    ASK --> OK["One approval, used once"]
    OK --> ACT["Discount, void, refund or reprint goes through"]
    ACT --> LOG["Recorded with who, why and the limits"]
```

Limits live on the server and are kept on the device so the till starts offline with them. An approval needs the connection, because a PIN cannot be checked on the device.

## 🧱 Data model

| Entity | What it is | Key fields or states |
|---|---|---|
| **POS Profile** | A register and its rules | Company, warehouse, price list, payments, users, limits, return policy, buyer rules, blind close, safe account, receipt paper |
| **POS Opening Entry** | A cashier's session | Register, user, opening balances, status (Draft, Open, Closed, Cancelled) |
| **POS Invoice** | A sale or a return | Items, payments, taxes, status (Draft, Paid, Unpaid, Return, Consolidated, Cancelled), loyalty, approvals, voided lines, buyer registration |
| **POS Closing Entry** | Ends a session | Counted amounts by method, denominations, differences, paid in, paid out, safe drops, tax rows, status (Draft, Submitted, Cancelled) |
| **POS Cash Movement** | Cash in, out or to the safe | Type (Cash In, Cash Out, Safe Drop), amount, account, reason |
| **POS Return Policy** | How a register takes returns | Window, price basis, store credit, refund methods, fees, exchange mode |
| **POS Role Limit** | What a role may do without approval | Discount, price change, voids, refund, returns, drawer, reprint |
| **POS Reason** | Reasons the till offers | For voids, returns, no sale and reprints |
| **POS Approval** | One approval by PIN | Approver, action, amount, reason, limits, expiry |
| **Receipt Event** | A reprint, gift receipt or message | Who, when, why, consent |
| **Stock Shortfall** | Stock sold offline beyond the warehouse | Item, quantity, sale, status (Open, Put Right), resolution |
| **Price Difference** | An offline sale priced differently | The three totals, review |
| **Loyalty Program, Loyalty Point Entry** | Points rules and ledger | Tiers, factor, expiry, entries |
| **Item Barcode** | Extra barcodes of an item | Pack barcodes, supplier codes |
| **Rows** (15) | Items, payments, taxes, approvals and voids on a sale; opening balances, denominations and tax of a closing; tiers; payment methods and users of a register; return fees and refund methods | |

| Role | What it can do |
|---|---|
| **Cashier** | Sells at a register: opens their own sessions, rings up sales and returns, records cash movements, counts the drawer. Sees their own sessions and sales |
| **POS Manager** | Runs the shop: registers, every session and sale, limits and reasons, discounts beyond the cashier limit, voids, closings and consolidation |

## 🔌 Integrations

| With | How | Needs |
|---|---|---|
| **ERP** | Items, prices, price lists, pricing rules, promotions, stored value, customers, taxes, sales invoices, credit notes, payments and stock | ERP `>=0.26` installed (done for you) |
| **Country add-ons** | Tax registration numbers and invoice rules, through ERP's localization seam | The country's add-on |
| **Mail and messages** | Receipts sent by message on the channels the workspace has | A channel |
| **Retail** | Goods sold at a till can be returned at any store | Retail installed |
| **Webhooks and the outbox** | Record events from the platform | An endpoint |
| **REST and MCP** | Every record and action, within each person's permissions | An API token |

Card terminals, UPI payment requests, receipt printers, cash drawers and scales are not connected yet: a card or UPI payment is a method with a reference the cashier types.

## 📊 How it compares

Leaders: Square POS, Shopify POS, Lightspeed Retail and Odoo POS (open source).

| Capability | Ferrum POS | Square | Shopify POS | Lightspeed | Odoo POS |
|---|:-:|:-:|:-:|:-:|:-:|
| Self-hosted, you hold the data | ✅ | ❌ | ❌ | ❌ | ✅ |
| Open-source licence | ✅ | ❌ | ❌ | ❌ | 🟡¹ |
| No per-register or monthly fee | ✅ | 🟡² | ❌ | ❌ | 🟡³ |
| Sales, stock and accounts are one data set | ✅ | 🟡⁴ | 🟡⁴ | 🟡⁴ | ✅ |
| Selling offline | ✅ | ✅ | 🟡 | ✅ | ✅ |
| Installable on a tablet or phone | ✅ | ✅ | ✅ | ✅ | ✅ |
| Barcode scan, quantity prefix, pack barcodes | ✅ | ✅ | ✅ | ✅ | ✅ |
| Split tenders and change | ✅ | ✅ | ✅ | ✅ | ✅ |
| Sales on hold | 🟡⁵ | ✅ | ✅ | ✅ | ✅ |
| Returns with and without a receipt, exchanges | ✅ | ✅ | ✅ | ✅ | ✅ |
| Manager approval by PIN without signing out | ✅ | ✅ | 🟡 | ✅ | ✅ |
| Limits by role: discount, refund, void | ✅ | ✅ | 🟡 | ✅ | 🟡 |
| Gift cards and store credit | ✅ | ✅ | ✅ | ✅ | ✅ |
| Loyalty points | ✅ | ✅ | 🟡 | 🟡 | ✅ |
| Promotions and discount codes | 🟡⁶ | ✅ | ✅ | ✅ | ✅ |
| Whole-sale discount at the till | ❌ | ✅ | ✅ | ✅ | ✅ |
| Tips | ❌ | ✅ | ✅ | 🟡 | ✅ |
| Cash drawer: float, drops, blind count, Z report | ✅ | ✅ | ✅ | ✅ | ✅ |
| Receipt layout the owner edits | ✅ | ✅ | ✅ | ✅ | ✅ |
| Receipt by email or message | 🟡⁷ | ✅ | ✅ | ✅ | ✅ |
| Direct receipt printing and cash drawer | ❌ | ✅ | ✅ | ✅ | ✅ |
| Card terminal in the sale flow | ❌ | ✅ | ✅ | ✅ | ✅ |
| Camera barcode scan | ❌ | ✅ | ✅ | ✅ | ✅ |
| Customer-facing display | ❌ | ✅ | 🟡 | ✅ | ✅ |
| Item grid with categories and pictures | 🟡⁸ | ✅ | ✅ | ✅ | ✅ |
| Size and colour variant picker | 🟡⁸ | ✅ | ✅ | ✅ | ✅ |
| Quick staff switch with a PIN | 🟡⁹ | ✅ | ✅ | ✅ | ✅ |
| Time clock | ❌ | ✅ | 🟡 | 🟡 | 🟡 |
| Fiscal printers and certified receipts by country | ❌ | ❌ | 🟡 | 🟡 | ✅ |
| Multi-store sales reports | 🟡¹⁰ | ✅ | ✅ | ✅ | ✅ |
| API and webhooks | ✅ | ✅ | ✅ | ✅ | ✅ |

<sub>¹ Odoo's Community edition is open source; some features are Enterprise only. ² Square has a free plan; hardware and payments carry fees. ³ Community is free; Enterprise is paid per user. ⁴ By accounting integrations, not one data set. ⁵ Held on the device only, per register and cashier; not shared between tills. ⁶ ERP's promotions for the Point of Sale channel and codes; whole-basket rules such as buy-one-get-one are not built. ⁷ By email or message channels the workspace has; the receipt text is a template. ⁸ ERP has variants; the till lists items as flat tiles and every variant as a plain item. ⁹ PIN approvals by another person work; signing in and switching user by PIN does not. ¹⁰ Reports are per register or company; a Studio dashboard can group by register.</sub>

### 🏆 Where Point of Sale stands out

- 🧮 Offline totals come from the server's own pricing code, and a difference is recorded for a person, never lost.
- 🧾 Closing consolidates into ERP invoices and credit notes that equal the till's totals, with the settlement and cash differences booked.
- 🛡️ Approvals by PIN, role limits, reasons, a reprint log and blind counts are built in.
- 🔁 Returns follow the original payment, with a policy, exchanges as one transaction, and stored value as the default refund.
- 🌐 Country rules for buyers' tax registrations are data from add-ons, not code in the till.
- 🏠 Self-hosted, open source, no per-register fee, with Arabic and Hindi.

### 🚧 Where the leaders are still ahead

- 🖨️ **Hardware.** Direct receipt printing, cash drawers, card terminals, weighing scales and customer displays.
- 📱 **A friendlier counter.** Item grids with categories and pictures, a variant picker, a camera scan and quick staff switching.
- 💳 **Selling more.** Tips, a whole-sale discount, special orders and layaway, and bundles.
- 🕒 **Staff.** A time clock, and staff PIN sign-in.
- 🧾 **Compliance.** Certified fiscal devices by country.

> [!NOTE]
> Leader columns are from public product information as of November 2026 and may change. Features marked 🟡 for a leader depend on plan, region or add-on.

## 📍 Roadmap

### ✅ Recently shipped

- [x] **0.7.4:** a fix for the shift screen reached from the till, and a register with no default customer asks for one.
- [x] **0.7.3:** ERP's pricing engine in the till as WebAssembly, offline sales priced with promotions and tax, returns and exchanges planned by the server, and blind close in the till.
- [x] **0.7.2:** one pricing for offline prices and the server's check, a signed price snapshot, exchanges planned by the server, and exact tax rows across the upgrade.
- [x] **0.7.0:** a buyer's tax registration on a sale, receipts as document templates with copies, gift receipts and receipts by message, promotions on POS sales, safe drops, blind close and a shift report.
- [x] **0.6.0:** limits by role, approval by another person's PIN, voids with reasons, stored value (gift cards and store credit), return policies, returns without a receipt and exchanges.
- [x] **0.5.0:** the register's policy for two tills offline that sell the last of something, with stock shortfalls to put right.

### 🔜 Next up

**Hardware and payments**
- [ ] Direct receipt printing and a cash drawer that opens on a cash sale and on no sale.
- [ ] A card terminal in the sale flow, and UPI payment requests with a QR the customer scans.
- [ ] A whole-sale discount at the till, and tips with presets.

**Cashier**
- [ ] Staff PIN sign-in and quick user switch on a shared till.
- [ ] An item grid with categories, pictures, colours and favourites.
- [ ] A variant picker for size and colour, and modifiers.
- [ ] Camera barcode scan on a phone or tablet.
- [ ] Customers on the device for offline search, and customer groups priced offline.
- [ ] Arabic and Hindi for the newest sentences.

**Selling**
- [ ] Held sales shared across tills and recalled by any cashier.
- [ ] Several tills under one register told apart, with a till id on every sale.
- [ ] Special orders and layaway: a deposit now, the balance later, stock reserved.
- [ ] Serial and batch entry on the sale.

### 🔭 Later

- [ ] A customer-facing display with the lines, total and a QR.
- [ ] Weighing scales and price by weight, with embedded-weight barcodes.
- [ ] Bundles and kits sold as one line with component stock.
- [ ] Age checks on restricted items.
- [ ] Salesperson or commission attribution per sale and line.
- [ ] Loyalty rewards: a free item at a number of points, coupons, stamp cards and birthday offers.
- [ ] Whole-basket promotions such as spend X get Y off and buy one get one, and time windows.
- [ ] Offline returns, customer search and gift-card sales.
- [ ] A time clock with breaks and hours to payroll.
- [ ] A phone-sized layout for floor selling.
- [ ] Hand a drawer over between cashiers without closing, and several cashiers on one drawer.
- [ ] Reports: cashier performance, discounts, voids and overrides, margin by item and category, and sales by store.
- [ ] Stale sessions warned or closed at the end of the day, and an owner's end-of-day message with sales and variances.
- [ ] Fiscal devices and signed receipts by country.
- [ ] Shelf labels and barcode printing, own barcode generation, and stock counts and receiving by scanning.
- [ ] Sync with an online shop such as Shopify or WooCommerce.

## 🚀 Install

Point of Sale is a native Ferrum app. It ships in the official Ferrum server image, and a workspace administrator installs it from **Apps** (`/store/`). It requires ERP `>=0.26`, and installing it in a workspace without ERP installs ERP whole. Self-hosters who build their own image enable the `pos` feature of the server.

First steps after installing:

1. Give people a role: **Cashier** or **POS Manager**.
2. Create a **POS Profile** for each register: company, warehouse, price list, payment methods (with their accounts), and the invoice prefix.
3. Add items and prices in ERP, and extra pack barcodes as **Item Barcodes**.
4. Set the register's rules: discounts, write-off limit, offline stock policy, buyer rules, blind close and a safe account. Add a **POS Return Policy** and **POS Role Limits** if you want them.
5. Optionally set up a **Loyalty Program**, and gift cards through ERP's stored value.
6. Open `/pos/`, pick the register, open a shift with a counted float and sell. Install it as an app from the browser to have its own window.

## 🔧 Develop

Clone it next to the platform:

```text
work/
├── ferrum/                  https://github.com/CBFerrum/Ferrum (with Ferrum-Frontend cloned into ferrum/web)
├── ferrum-app-erp/          optional, for working on both together
└── ferrum-app-pos/
```

Point the platform dependencies at your checkout (this file is git-ignored):

```toml
# .cargo/config.toml
[patch."https://github.com/CBFerrum/Ferrum"]
ferrum-calc = { path = "../ferrum/crates/calc" }
ferrum-domain = { path = "../ferrum/crates/domain" }
ferrum-kernel = { path = "../ferrum/crates/kernel" }
ferrum-meta = { path = "../ferrum/crates/meta" }
```

The tests need PostgreSQL with an ordinary (non-superuser) role, so row-level security applies:

```bash
createuser ferrum --pwprompt && createdb -O ferrum ferrum_pos_test
export FERRUM_POS_TEST_DATABASE_URL=postgres://ferrum:ferrum@localhost:5432/ferrum_pos_test
cargo fmt -- --check
cargo clippy --all-targets -- -D warnings
cargo test
```

It also builds on [ferrum-app-erp](https://github.com/CBFerrum/ferrum-app-erp) (the app and its pricing crate), which Cargo takes from GitHub. To work on it alongside this app, clone it into the same folder and add:

```toml
[patch."https://github.com/CBFerrum/ferrum-app-erp"]
ferrum-app-erp = { path = "../ferrum-app-erp" }
ferrum-erp-pricing = { path = "../ferrum-app-erp/pricing" }
```

The till (`ui/`) is built with the platform's packages from the sibling `ferrum/web` checkout, and its built files (`ui/dist`) are committed and embedded in the crate. ERP's pricing engine is vendored in `ui/src/vendor/pricing/` as WebAssembly, built by ERP's `scripts/pricing-wasm.sh`; its README names the two files' SHA-256 digests and how to update them. After changing `ui/src`:

```bash
cd ui
npm run test && npm run typecheck && npm run build && npm run check
```

## 📂 Project layout

```text
app.yaml          the manifest: id, version, requirements, what it adds to Ferrum
packages/pos/     metadata: entities, roles, reports, document templates, SQL migrations, a client guide
src/              the logic in Rust: invoice, session, closing, returns, limits, snapshot,
                  stored value, loyalty, receipts, buyers, shortfalls, reports, the till's routes
ui/               the till and its screens (React, TypeScript)
ui/public/sw.js   the till's own worker, served at /pos/sw.js
ui/src/vendor/pricing/  ERP's pricing engine built for the browser
tests/            integration tests against a real PostgreSQL
CHANGELOG.md      what changed in each version
```

## 📜 Changelog

Every version is in [CHANGELOG.md](CHANGELOG.md).

## 🤝 Contributing

Issues and pull requests are welcome at [github.com/CBFerrum/ferrum-app-pos](https://github.com/CBFerrum/ferrum-app-pos/issues). Run the checks in Develop first.

## 📄 License

[AGPL-3.0-only](LICENSE), like the platform.

<div align="center">

<sub>Part of <a href="https://github.com/CBFerrum/Ferrum">Ferrum</a>, the open business platform · Made with 🦀 Rust and 🐘 PostgreSQL</sub>

</div>
