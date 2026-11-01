// The sale on screen: its lines, each with a way to change it where it stands, and the totals. A
// line shows what it costs and what was done to it; tapping it opens its editor, where quantity,
// discount, price and a note are changed, and what the cashier may change follows their role: the
// register's switches and the cap are shown before typing, and what goes past them is not sent
// (the server would refuse it; `lineProblem` is its sum, done early).

import { Minus, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@ferrum/kit";
import type { Doc } from "@ferrum/records";
import { num, useMoney } from "./fmt";
import type { CartLine } from "./lib/pos";
import { discountLimit, lineProblem, type Rights } from "./lib/rights";

/** What a line was priced from, when known: the list price and the discount the pricing rules gave. */
export interface Base {
  list: number;
  rule: number;
}

const plain = (n: number) => String(Math.round(n * 100) / 100);

export function CartLines({
  lines,
  priced,
  pending,
  selected,
  editing,
  rights,
  baseOf,
  onSelect,
  onEdit,
  onQty,
  onChange,
  onRemove,
}: {
  lines: CartLine[];
  priced: Doc[];
  pending: boolean;
  selected: string | null;
  editing: string | null;
  rights: Rights;
  baseOf: (line: CartLine) => Base | null;
  onSelect: (key: string) => void;
  onEdit: (key: string | null) => void;
  onQty: (key: string, qty: number) => void;
  onChange: (key: string, patch: Partial<Pick<CartLine, "discount" | "price" | "note">>) => void;
  onRemove: (key: string) => void;
}) {
  const money = useMoney();
  return (
    <ul className="pos-lines" aria-label="Sale lines">
      {lines.map((l, i) => {
        // Totals worked out for an older cart may not be this line's yet: a price shows only on its own line.
        const p = priced[i]?.item === l.item ? priced[i] : undefined;
        const open = editing === l.key;
        const off = num(p?.discount_percent);
        return (
          <li key={l.key} className="pos-line" data-selected={selected === l.key || undefined}>
            <button
              type="button"
              className="pos-line-main"
              aria-expanded={open}
              title="Change this line"
              onClick={() => {
                onSelect(l.key);
                onEdit(open ? null : l.key);
              }}
            >
              <span className="pos-line-name">{l.item_name}</span>
              <span className="pos-line-sub">
                {p ? `${money(p.rate)} each` : pending ? "Pricing…" : ""}
                {off > 0 && <span className="pos-tag">−{plain(off)}%</span>}
                {l.price && <span className="pos-tag">price changed</span>}
              </span>
              {l.note && <span className="pos-line-note">{l.note}</span>}
            </button>
            <span className="pos-line-total">{p ? money(p.amount) : ""}</span>
            <span className="pos-qty">
              <Button className="pos-step" aria-label={`One less ${l.item_name}`} disabled={l.qty <= 1} onClick={() => onQty(l.key, l.qty - 1)}>
                <Minus className="size-4" aria-hidden="true" />
              </Button>
              <QtyBox label={l.item_name} qty={l.qty} onChange={(v) => onQty(l.key, v)} />
              <Button className="pos-step" aria-label={`One more ${l.item_name}`} onClick={() => onQty(l.key, l.qty + 1)}>
                <Plus className="size-4" aria-hidden="true" />
              </Button>
            </span>
            {open && <LineEditor line={l} rights={rights} base={baseOf(l)} onChange={(patch) => onChange(l.key, patch)} onRemove={() => onRemove(l.key)} onDone={() => onEdit(null)} />}
          </li>
        );
      })}
    </ul>
  );
}

/** A quantity box that only applies positive numbers, so clearing it to retype never drops the line. */
function QtyBox({ label, qty, onChange }: { label: string; qty: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(qty));
  const [shown, setShown] = useState(qty);
  if (shown !== qty) {
    setShown(qty);
    setText(String(qty));
  }
  return (
    <input
      className="input pos-qty-box"
      inputMode="decimal"
      aria-label={`Quantity of ${label}`}
      value={text}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        setText(e.target.value);
        const v = Number(e.target.value);
        if (e.target.value.trim() && Number.isFinite(v) && v > 0) onChange(v);
      }}
      onBlur={() => setText(String(qty))}
    />
  );
}

function LineEditor({ line, rights, base, onChange, onRemove, onDone }: { line: CartLine; rights: Rights; base: Base | null; onChange: (patch: Partial<Pick<CartLine, "discount" | "price" | "note">>) => void; onRemove: () => void; onDone: () => void }) {
  const money = useMoney();
  const [discount, setDiscount] = useState(line.discount ?? "");
  const [price, setPrice] = useState(line.price ?? "");
  const check = (d: string, p: string) => lineProblem(rights, { list: base?.list ?? 0, rule: base?.rule ?? 0, discount: d, price: p });
  const problem = check(discount, price);
  const limit = base ? discountLimit(rights, base.rule) : rights.max;
  // What is typed goes onto the line once it is allowed; until then it stays here with the reason.
  const typed = (d: string, p: string) => {
    if (!check(d, p)) onChange({ discount: d, price: p });
  };
  return (
    <div className="pos-edit">
      {base && (
        <p className="faint pos-edit-info">
          List price {money(base.list)}
          {base.rule > 0 ? ` · pricing rules take off ${plain(base.rule)}%` : ""}
        </p>
      )}
      <div className="pos-edit-grid">
        {rights.discount ? (
          <label className="field">
            <span className="field-label">Discount %</span>
            <input
              className="input"
              inputMode="decimal"
              placeholder={base && base.rule > 0 ? plain(base.rule) : "0"}
              value={discount}
              aria-invalid={!!problem || undefined}
              onChange={(e) => {
                setDiscount(e.target.value);
                typed(e.target.value, price);
              }}
            />
            <span className="field-hint">{rights.manager ? "No limit for you." : `You can give up to ${plain(limit)}%.`}</span>
          </label>
        ) : (
          <p className="faint pos-edit-info">This register does not let cashiers give discounts.</p>
        )}
        {rights.price && (
          <label className="field">
            <span className="field-label">Price</span>
            <input
              className="input"
              inputMode="decimal"
              placeholder={base ? plain(base.list) : ""}
              value={price}
              aria-invalid={!!problem || undefined}
              onChange={(e) => {
                setPrice(e.target.value);
                typed(discount, e.target.value);
              }}
            />
          </label>
        )}
        <label className="field pos-edit-note">
          <span className="field-label">Note on this line</span>
          <input className="input" maxLength={200} defaultValue={line.note ?? ""} placeholder="A gift, a promised repair…" onChange={(e) => onChange({ note: e.target.value })} />
        </label>
      </div>
      {problem && (
        <p className="pos-edit-problem" role="alert">
          {problem}
        </p>
      )}
      <div className="pos-edit-actions">
        <Button variant="danger" icon="trash" onClick={onRemove}>
          Remove line
        </Button>
        <span className="spacer" />
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

/** What the sale comes to: subtotal, discount, taxes, the rounding the currency needs, and the total. */
export function Totals({ doc, due, offline, builtAt }: { doc: Doc; due: number; offline?: boolean; builtAt?: string }) {
  const money = useMoney();
  const rounding = num(doc.rounding_adjustment);
  return (
    <dl className="pos-totals">
      <dt>Subtotal</dt>
      <dd>{money(doc.total)}</dd>
      {num(doc.discount_amount) !== 0 && (
        <>
          <dt>Discount</dt>
          <dd>−{money(doc.discount_amount)}</dd>
        </>
      )}
      <dt>Taxes</dt>
      <dd>{money(doc.total_taxes)}</dd>
      {rounding !== 0 && (
        <>
          <dt>Rounding</dt>
          <dd>{rounding > 0 ? "+" : "−"}{money(Math.abs(rounding))}</dd>
        </>
      )}
      <dt className="pos-total-label">Total</dt>
      <dd className="pos-total" aria-live="polite">{money(due)}</dd>
      {offline && builtAt && (
        <dd className="pos-totals-note faint">Priced on this device (prices of {new Date(builtAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}); checked again when the sale is sent.</dd>
      )}
    </dl>
  );
}
