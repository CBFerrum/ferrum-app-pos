// The sale on screen: its lines, each with a way to change it where it stands, and the totals. A
// line shows what it costs and what was done to it; tapping it opens its editor, where quantity,
// discount, price and a note are changed, and what the cashier may change follows their limits (from
// the server): the cap is shown before typing, and what goes past it is not put on the line until
// another person approves it (`lineAsks` is the server's sum, done early). A line that sells a card
// takes the card's code.

import { Minus, Plus } from "lucide-react";
import { useState } from "react";
import { formatMoment, t, isolate } from "@ferrum/client";
import { Button, placed } from "@ferrum/kit";
import type { Doc } from "@ferrum/records";
import { CardLine } from "./Card";
import { num, str, useMoney } from "./fmt";
import type { CartLine, LineCards } from "./lib/pos";
import { promotionsLater } from "./lib/offline";
import { discountLimit, lineAsks, lineProblem, type Approval, type Ask, type Limits } from "./lib/rights";
import { lastFour } from "./lib/stored";

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
  limits,
  approvals,
  profile,
  cards,
  away,
  baseOf,
  onSelect,
  onEdit,
  onQty,
  onChange,
  onAsk,
  onCard,
  onRemove,
}: {
  lines: CartLine[];
  priced: Doc[];
  pending: boolean;
  selected: string | null;
  editing: string | null;
  limits: Limits;
  approvals: Approval[];
  profile: Doc;
  /** The card codes set on lines (kept in memory by the till). */
  cards: LineCards;
  /** The server cannot be reached: nothing can be approved or made. */
  away: boolean;
  baseOf: (line: CartLine) => Base | null;
  onSelect: (key: string) => void;
  onEdit: (key: string | null) => void;
  onQty: (key: string, qty: number) => void;
  onChange: (key: string, patch: Partial<Pick<CartLine, "discount" | "price" | "note">>) => void;
  /** Ask another person to approve what the line asks beyond the limits, then apply it. */
  onAsk: (asks: Ask[], apply: () => void) => void;
  onCard: (key: string, code: string, pin?: string) => void;
  onRemove: (key: string) => void;
}) {
  const money = useMoney();
  return (
    <ul className="pos-lines" aria-label={t("Sale lines")}>
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
              title={t("Change this line")}
              onClick={() => {
                onSelect(l.key);
                onEdit(open ? null : l.key);
              }}
            >
              <span className="pos-line-name">{isolate(l.item_name)}</span>
              <span className="pos-line-sub">
                {p ? t("{value} each", { value: money(p.rate) }) : pending ? t("Pricing…") : ""}
                {off > 0 && <span className="pos-tag">−{isolate(plain(off))}%</span>}
                {l.price && <span className="pos-tag">{t("price changed")}</span>}
              </span>
              {l.note && <span className="pos-line-note">{isolate(l.note)}</span>}
            </button>
            <span className="pos-line-total">{p ? money(p.amount) : ""}</span>
            <span className="pos-qty">
              <Button className="pos-step" aria-label={t("One less {item_name}", { item_name: l.item_name })} disabled={l.qty <= 1} onClick={() => onQty(l.key, l.qty - 1)}>
                <Minus className="size-4" aria-hidden="true" />
              </Button>
              <QtyBox label={l.item_name} qty={l.qty} onChange={(v) => onQty(l.key, v)} />
              <Button className="pos-step" aria-label={t("One more {item_name}", { item_name: l.item_name })} onClick={() => onQty(l.key, l.qty + 1)}>
                <Plus className="size-4" aria-hidden="true" />
              </Button>
            </span>
            {open && (
              <LineEditor
                line={l}
                limits={limits}
                approvals={approvals}
                base={baseOf(l)}
                away={away}
                card={p && str(p.stored_value_kind) ? { kind: str(p.stored_value_kind), set: cards[l.key]?.code ? lastFour(cards[l.key].code) : null, profile, onUse: (code, pin) => onCard(l.key, code, pin) } : null}
                onChange={(patch) => onChange(l.key, patch)}
                onAsk={onAsk}
                onRemove={() => onRemove(l.key)}
                onDone={() => onEdit(null)}
              />
            )}
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
      aria-label={t("Quantity of {label}", { label })}
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

function LineEditor({
  line,
  limits,
  approvals,
  base,
  away,
  card,
  onChange,
  onAsk,
  onRemove,
  onDone,
}: {
  line: CartLine;
  limits: Limits;
  approvals: Approval[];
  base: Base | null;
  away: boolean;
  card: { kind: string; set: string | null; profile: Doc; onUse: (code: string, pin?: string) => void } | null;
  onChange: (patch: Partial<Pick<CartLine, "discount" | "price" | "note">>) => void;
  onAsk: (asks: Ask[], apply: () => void) => void;
  onRemove: () => void;
  onDone: () => void;
}) {
  const money = useMoney();
  const [discount, setDiscount] = useState(line.discount ?? "");
  const [price, setPrice] = useState(line.price ?? "");
  const problem = lineProblem({ discount, price });
  const asks = lineAsks(limits, { list: base?.list ?? 0, rule: base?.rule ?? 0, discount, price }, approvals);
  const limit = base ? discountLimit(limits, base.rule) : limits.discount_percent;
  // What is typed goes onto the line once it is allowed; until then it stays here with the way to ask.
  const typed = (d: string, p: string) => {
    if (!lineProblem({ discount: d, price: p }) && !lineAsks(limits, { list: base?.list ?? 0, rule: base?.rule ?? 0, discount: d, price: p }, approvals).length) onChange({ discount: d, price: p });
  };
  const words = (a: Ask) =>
    a.act === "Price Change"
      ? t("You may not change prices yourself; another person has to approve it.")
      : t("That is {saving}% off the list price. You can give up to {limit}% yourself; more needs another person's approval.", { saving: plain(a.figure), limit: plain(limit) });
  return (
    <div className="pos-edit">
      {base && (
        <p className="faint pos-edit-info">
          {t("List price")} {isolate(money(base.list))}
          {base.rule > 0 ? t(" · pricing rules take off {value}%", { value: plain(base.rule) }) : ""}
        </p>
      )}
      <div className="pos-edit-grid">
        <label className="field">
          <span className="field-label">{t("Discount %")}</span>
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
          <span className="field-hint">{limit >= 100 ? t("No limit for you.") : t("You can give up to {limit}% yourself.", { limit: plain(limit) })}</span>
        </label>
        <label className="field">
          <span className="field-label">{t("Price")}</span>
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
        <label className="field pos-edit-note">
          <span className="field-label">{t("Note on this line")}</span>
          <input className="input" maxLength={200} defaultValue={line.note ?? ""} placeholder={t("A gift, a promised repair…")} onChange={(e) => onChange({ note: e.target.value })} />
        </label>
      </div>
      {problem && (
        <p className="pos-edit-problem" role="alert">
          {isolate(problem)}
        </p>
      )}
      {!problem && asks.length > 0 && (
        <div className="pos-edit-problem" role="alert">
          {asks.map((a) => (
            <p key={a.act}>{isolate(words(a))}</p>
          ))}
          <Button className="pos-btn" disabled={away} onClick={() => onAsk(asks, () => onChange({ discount, price }))}>
            {t("Ask for approval")}
          </Button>
          {away && <span className="faint"> {t("Approvals need a connection.")}</span>}
        </div>
      )}
      {card && <CardLine profile={card.profile} line={line.key} kind={card.kind} set={card.set} away={away} onUse={card.onUse} />}
      <div className="pos-edit-actions">
        <Button variant="danger" className="pos-btn" icon="trash" onClick={onRemove}>
          {t("Remove line")}
        </Button>
        <span className="spacer" />
        <Button variant="primary" className="pos-btn" onClick={onDone}>
          {t("Done")}
        </Button>
      </div>
    </div>
  );
}

/** What the sale comes to: subtotal, discount, taxes, the rounding the currency needs, and the total. */
export function Totals({ doc, due, offline, builtAt, version }: { doc: Doc; due: number; offline?: boolean; builtAt?: string; version?: string }) {
  const money = useMoney();
  const rounding = num(doc.rounding_adjustment);
  return (
    <dl className="pos-totals">
      <dt>{t("Subtotal")}</dt>
      <dd>{isolate(money(doc.total))}</dd>
      {num(doc.discount_amount) !== 0 && (
        <>
          <dt>{t("Discount")}</dt>
          <dd>−{isolate(money(doc.discount_amount))}</dd>
        </>
      )}
      <dt>{t("Taxes")}</dt>
      <dd>{isolate(money(doc.total_taxes))}</dd>
      {rounding !== 0 && (
        <>
          <dt>{t("Rounding")}</dt>
          <dd>{rounding > 0 ? "+" : "−"}{isolate(money(Math.abs(rounding)))}</dd>
        </>
      )}
      <dt className="pos-total-label">{t("Total")}</dt>
      <dd className="pos-total" aria-live="polite">{isolate(money(due))}</dd>
      {offline && builtAt && (
        <dd className="pos-totals-note faint">
          {placed(t("Priced on this device (prices of {p1}); checked again when the sale is sent."), { p1: isolate(formatMoment(builtAt, { dateStyle: "short", timeStyle: "short" })) })}
          {version ? ` ${t("Snapshot {version}.", { version: version.slice(0, 8) })}` : ""}
        </dd>
      )}
      {offline && <dd className="pos-totals-note faint">{promotionsLater()}</dd>}
    </dl>
  );
}
