// Counting cash: a plus and a minus for every note and coin of the currency, and an amount for
// anything that is neither. It fills the counted cash, so a drawer is counted once, in the order
// it is laid out, instead of added up on paper. Used to open a shift (the float) and to close it.

import { Minus, Plus } from "lucide-react";
import { useContext } from "react";
import { Button } from "@ferrum/kit";
import { Currency, useMoney } from "./fmt";
import { cashCounted, denominations, typedAmount } from "./lib/shift";
import { t } from "@ferrum/client";

export interface Counted {
  counts: Record<string, number>;
  /** An amount typed for what is not a note or a coin of the list (vouchers, foreign coins). */
  other: string;
}

/** What a count comes to. */
export const countTotal = (c: Counted, precision = 2) => cashCounted(c.counts, typedAmount(c.other) ?? 0, precision);

export function CashCounter({ value, onChange }: { value: Counted; onChange: (next: Counted) => void }) {
  const money = useMoney();
  const { code, precision } = useContext(Currency);
  const d = denominations(code);
  const set = (denomination: number, n: number) => onChange({ ...value, counts: { ...value.counts, [String(denomination)]: Math.max(0, Math.floor(n) || 0) } });
  const row = (denomination: number, what: string) => {
    const n = value.counts[String(denomination)] ?? 0;
    return (
      <li key={`${what}-${denomination}`} className="pos-denom">
        <span>
          {money(denomination)} <span className="faint">{what}</span>
        </span>
        <span className="pos-qty">
          <Button className="pos-step" aria-label={`One less ${money(denomination)} ${what}`} disabled={n <= 0} onClick={() => set(denomination, n - 1)}>
            <Minus className="size-4" aria-hidden="true" />
          </Button>
          <input
            className="input pos-qty-box"
            inputMode="numeric"
            aria-label={`How many ${money(denomination)} ${what}`}
            value={n || ""}
            placeholder="0"
            onFocus={(e) => e.target.select()}
            onChange={(e) => set(denomination, Number(e.target.value.replace(/\D/g, "")))}
          />
          <Button className="pos-step" aria-label={`One more ${money(denomination)} ${what}`} onClick={() => set(denomination, n + 1)}>
            <Plus className="size-4" aria-hidden="true" />
          </Button>
        </span>
        <span className="pos-denom-sum">{n ? money(denomination * n) : ""}</span>
      </li>
    );
  };
  return (
    <div className="pos-counter">
      <ul className="pos-denoms" aria-label={t("Notes and coins")}>
        {d.notes.map((v) => row(v, "note"))}
        {d.coins.map((v) => row(v, "coin"))}
        <li className="pos-denom">
          <label htmlFor="count-other">{t("Anything else")}</label>
          <input id="count-other" className="input pos-other" inputMode="decimal" placeholder="0" value={value.other} onChange={(e) => onChange({ ...value, other: e.target.value })} />
          <span />
        </li>
      </ul>
      <p className="pos-counter-total">
        <span className="muted">{t("Counted")}</span>
        <strong>{money(countTotal(value, precision))}</strong>
      </p>
    </div>
  );
}
