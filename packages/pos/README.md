# Point of Sale (`pos`)

Registers, cashier sessions, fast POS invoices with split payments and returns, loyalty points,
cash control, and end-of-day consolidation into sales invoices and the books. Business logic:
`crates/pkg-pos`. Depends on `core`, `accounting`, `inventory`, `selling`.

| Entity | What it is |
|---|---|
| `ModeOfPayment` | Tender: `mode_type` Cash, Bank (card, UPI, wallet), General, Credit (on account), Loyalty Points; account per company (Cash/Bank fall back to the company cash/bank account). Seeded: Cash, Card, UPI, Wallet, Credit, Loyalty Points |
| `PosProfile` | A register: company, warehouse, price list, walk-in customer, tax template, payment methods (default, allowed in returns), invoice prefix, write-off account/limit, cash-difference account, negative stock, cashier discount/price rights, item and customer groups, receipt texts |
| `PosOpeningEntry` | A cashier's session (submittable): opening float per payment method. One open session per register and cashier |
| `PosInvoice` | A sale or return (submittable). Stock moves on submit; numbers are `PREFIX-<FY>-000001`, gapless per prefix |
| `PosCashMovement` | Cash In / Cash Out of a drawer during a session (float top-up, petty cash), posted to the ledger |
| `PosClosingEntry` | Ends a session: counted vs expected per payment method, then consolidation |
| `LoyaltyProgram`, `LoyaltyPointEntry` | Tiers by lifetime spend, points value, expiry; the points ledger (read-only) |
| `ItemBarcode` | Extra barcodes per item (pack barcodes add several units per scan). `Item.barcode` and `Item.item_code` scan too |

Roles: **Cashier** (own sessions, sales, returns, cash movements; may draft the closing count) and
**POS Manager** (everything, including discounts beyond the register limit, price changes, voids,
closings and their cancellation).

## Client flow

All calls carry `Authorization: Bearer <token>` (`POST /api/auth/login {tenant, email, password}`).
Money is sent and returned as strings.

### 1. Load the register

```
GET /api/v1/PosProfile/{profile}            → payments, customer, invoice_prefix, receipt_header/footer, print_format…
GET /api/v1/ModeOfPayment?fields=id,mode_name,mode_type
```

### 2. Open (or resume) the session

```
GET /api/v1/PosOpeningEntry?filters=[["pos_profile","=","<profile>"],["status","=","Open"]]
```

None open → create and submit one:

```
POST /api/v1/PosOpeningEntry
{"pos_profile": "<profile>", "balance_details": [{"mode_of_payment": "<cash>", "opening_amount": "500"}]}

POST /api/v1/PosOpeningEntry/{id}/submit    → status "Open"
```

### 3. Scan or search items (one cheap query per call)

```
GET /api/reports/pos_item_lookup?pos_profile=<profile>&code=8901234567890
GET /api/reports/pos_item_lookup?pos_profile=<profile>&search=pen
GET /api/reports/pos_item_lookup?pos_profile=<profile>&item_group=<group>
```

```json
{"rows": [{"item": "<id>", "item_code": "PEN", "item_name": "Pen", "uom": "Nos", "qty": "1", "rate": "9.99",
           "actual_qty": "99", "is_stock_item": true, "has_serial_no": false, "has_batch_no": false}]}
```

`qty` is how many stock units the scanned code stands for (a box barcode may add 12). `rate` is the
price-list price; pricing rules, taxes and rounding are applied by the invoice itself.

### 4. Live totals while the cart changes

`POST /api/v1/PosInvoice/_calc` with the cart (same body as below) returns the computed document
without saving: line rates, discounts from pricing rules, taxes, `rounded_total`, `paid_amount`,
`change_amount`, `write_off_amount`. Discount and price limits are enforced here too (422).

### 5. Ring up the sale

Give every sale a UUID on the device and send it both as `id` and as the `Idempotency-Key`:

```
POST /api/v1/PosInvoice
Idempotency-Key: 0192f3c4-7a1e-7c3b-9d2a-5b8e1f0a6c11
{
  "id": "0192f3c4-7a1e-7c3b-9d2a-5b8e1f0a6c11",
  "pos_profile": "<profile>",
  "posting_date": "2026-10-29", "posting_time": "10:15:00",
  "customer": null,
  "items": [
    {"item": "<widget>", "qty": "2"},
    {"item": "<pen>", "qty": "1", "discount_percent": "5"},
    {"item": "<phone>", "qty": "1", "serial_no": "SN-1"}
  ],
  "payments": [
    {"mode_of_payment": "<card>", "amount": "100", "reference_no": "AUTH 123456"},
    {"mode_of_payment": "<cash>", "amount": "150"}
  ]
}

POST /api/v1/PosInvoice/{id}/submit   → status "Paid" (or "Unpaid" with a Credit part), number "C1-2026-27-000001"
```

* The session is found from the profile and the signed-in cashier; `pos_opening_entry` may be sent explicitly.
* `customer` empty = the register's walk-in customer. Credit and Loyalty Points need a named customer.
* Change only comes out of cash; card/UPI/points may not exceed what is due. A shortfall up to the
  profile's `write_off_limit` is written off; more is refused.
* Loyalty: `{"mode_of_payment": "<points>", "loyalty_points": 40}` — the amount is computed.
* Price override: `manual_rate` on a line (needs `allow_rate_change`); discounts need
  `allow_discount_change` and stay within `max_discount` (line and invoice discount together).
  A POS Manager may exceed both.
* A held (parked) sale is just a draft: create without submitting; resume with `PATCH`, discard with `DELETE`.

**Offline replay.** Queue `create` + `submit` per sale and replay them in order when back online:

| Reply | Meaning |
|---|---|
| `201` / `200` with `Idempotent-Replayed: true` | Created (or already created within 24 h) |
| `409` on create | The id exists (an older replay): treat as created |
| `422 "only draft documents can be submitted"` on submit | Already submitted |
| any other `4xx` | `GET /api/v1/PosInvoice/{id}`: `docstatus` 1 means the sale is recorded; otherwise show the error (e.g. no stock left, session closed) |

The device's `posting_date` must lie inside the session (from its opening date to today); stock is
checked at submit, so a sale made offline can be refused if stock ran out meanwhile (unless the
profile allows negative stock).

### 6. Returns

```
POST /api/v1/PosInvoice
{"pos_profile": "<profile>", "is_return": true, "return_against": "<sale id>",
 "items": [{"item": "<widget>", "qty": "-1"}],
 "payments": [{"mode_of_payment": "<cash>", "amount": "-110"}]}
```

then submit. Prices, discounts, taxes and customer come from the sale; `original_line` (the sale's
line id) is filled in when the item is on one line of the sale. Refused: returning more than a line
sold, serials not sold on it, refunds that do not add up to the return, refunds through a method
not allowed in returns, more cash/card refund than the sale took in cash/card, more points than it
redeemed. What the customer still owes on the sale (Credit) is refunded to Credit first. The sale
must be closed already or be in the same session. Goods come back at the cost they left at; earned
points are taken back pro rata.

### 7. Cash in / out

```
POST /api/v1/PosCashMovement
{"pos_opening_entry": "<session>", "movement_type": "Cash Out", "amount": "20",
 "account": "<expense account>", "reason": "Courier"}
```

then submit (Cash In credits the counter account, e.g. the safe or bank).

### 8. X report (mid-session)

```
GET /api/reports/pos_sales_summary?pos_opening_entry=<session>
```

Rows: takings per session, cashier and payment method (net of change and refunds).
`meta.session.reconciliation`: opening, expected, counted and difference per payment method;
`meta.session.report` is `"X"` while open and `"Z"` once closed.

### 9. Close

The cashier counts and saves a draft; a POS Manager submits it.

```
POST /api/v1/PosClosingEntry
{"pos_opening_entry": "<session>",
 "payments": [{"mode_of_payment": "<card>", "closing_amount": "199"}],
 "denominations": [{"denomination": "500", "count": 1}, {"denomination": "100", "count": 2}, {"denomination": "0.05", "count": 9}]}

POST /api/v1/PosClosingEntry/{id}/submit
```

The response shows `payments` with `opening_amount`, `expected_amount`, `closing_amount` (counted;
denominations count the cash mode) and `difference`. Submitting refuses while draft sales remain in
the session, then consolidates and closes the session.

## Consolidation and the books

* **On sale**: stock leaves the register's warehouse with its valuation entry (Dr cost of goods
  sold, Cr stock), exactly as a delivery note — stock value and stock accounts always agree.
* **On closing** (ERPNext-compatible): the session's paid sales become **one Sales Invoice per
  customer**; a sale with a Credit (pay later) part gets **its own Sales Invoice**, so each unpaid
  sale is a separate receivable with its due date. Returns become **one credit note per customer
  and original invoice**. They never move stock (`update_stock` off). Taxes are the POS taxes as
  fixed amounts and cash rounding is carried as an amount to the round-off account, so every
  consolidated total equals its POS invoices exactly (verified; a mismatch refuses the closing).
* One journal entry of the closing settles each consolidated invoice: Dr each payment method's
  account (cash net of change), Dr loyalty expense for redeemed points, Dr write-off account,
  Cr the receivable (allocated to the invoice). Credit parts stay open on their invoice.
  Counting differences post between the payment method's account and the cash-difference account
  (default: company round-off account).
* Cancelling a closing reverses the settlement, cancels its invoices and credit notes, returns the
  POS invoices to Paid/Unpaid/Return and reopens the session. It is refused when later credit notes,
  payments or returns depend on it, or when the cashier has opened a new session at the register.
* A POS invoice can be voided (cancelled, POS Manager) only before its session closes; afterwards
  make a return.

## Reports

`pos_sales_summary` (X/Z), `pos_daily_sales` (by item or item group: qty, net, tax share),
`pos_payment_reconciliation` (expected vs counted per closing), `pos_top_items`, `pos_hourly_sales`,
`pos_returns`, `pos_item_lookup`. Cashiers whose role reads only their own POS invoices see only
their own figures.

## Loyalty

Points are earned on submit at the customer's tier (`collection_factor` = amount per point; tiers by
lifetime spend in the program), not on what points paid for. Redeeming takes the soonest-expiring
points first; returns and cancellations take points back (or give redeemed ones back). Earned points
expire `expiry_days` after the sale (`maintenance`, every minute). The walk-in customer never collects.

## Limits

* POS invoices are in the company currency; quantities in the item's stock unit (pack barcodes add
  several units).
* Cash rounding follows the company's `round_total_to`.
* A named customer with a credit limit is checked at the register against outstanding plus unclosed
  register sales, because the consolidated invoice counts against the limit like any sales invoice.
* Gift cards / store credit are not included.
