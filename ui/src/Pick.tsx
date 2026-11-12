// Choosing goods at the return desk: scan a code or search by name (a code that names one item adds it; otherwise the matches are
// listed to tap), and a quantity box. Shared by returns without a receipt and by exchanges.

import { useQuery } from "@tanstack/react-query";
import { Minus, Plus } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { docPath, t, isolate } from "@ferrum/client";
import { Button, Field, useDebounced } from "@ferrum/kit";
import type { Doc } from "@ferrum/records";
import { num, str, titleOf } from "./fmt";
import { till } from "./lib/offline";

export interface Picked {
  id: string;
  name: string;
}

/** Scan a code or search by name; a code that names one item adds it, otherwise the matches are listed to tap. */
export function Finder({ label, onPick }: { label: string; onPick: (item: Picked, qty: number) => void }) {
  const id = useId();
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 250);
  const found = useQuery({
    queryKey: ["pos", "find-item", q],
    enabled: q.length > 0,
    queryFn: ({ signal }) =>
      till<{ rows: Doc[] }>(docPath("Item"), { query: { search: q, fields: "id,item_code,item_name,barcode", filters: JSON.stringify({ disabled: false }), limit: 8 }, signal }),
    staleTime: 30_000,
  });
  const name = (r: Doc) => str(r.item_name) || str(r.item_code);
  const rows = found.data?.rows ?? [];
  const pick = (r: Doc, qty = 1) => (onPick({ id: str(r.id), name: name(r) }, qty), setText(""));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const code = text.trim();
    if (!code) return;
    try {
      // A pack barcode (a case of six scans as six), else an exact barcode or code, else the only match.
      const packs = await till<{ rows: Doc[] }>(docPath("ItemBarcode"), { query: { filters: JSON.stringify({ barcode: code }), fields: "item,qty", titles: true, limit: 1 } });
      const pack = packs.rows[0];
      if (pack) return void (onPick({ id: str(pack.item), name: titleOf(pack, "item") }, num(pack.qty) || 1), setText(""));
    } catch {
      // packs are an extra: the search below still answers
    }
    const exact = rows.filter((r) => str(r.barcode) === code || str(r.item_code).toLowerCase() === code.toLowerCase());
    const one = exact.length === 1 ? exact[0] : rows.length === 1 ? rows[0] : undefined;
    if (one) pick(one);
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="pos-returns">
      <Field label={label} htmlFor={id} hint={t("Scan a barcode, or type a name and tap the item.")}>
        <input id={id} className="input" autoComplete="off" autoCapitalize="off" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      {q && rows.length > 0 && (
        <ul className="pos-found" aria-label={t("Items")}>
          {rows.map((r) => (
            <li key={str(r.id)}>
              <button type="button" className="pos-found-row" onClick={() => pick(r)}>
                <span className="pos-found-main">
                  <strong>{isolate(name(r))}</strong>
                  <span className="faint">{isolate(str(r.item_code))}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {q && found.data && rows.length === 0 && <p className="muted">{t("Nothing matches “{text}”", { text: q })}</p>}
      <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
    </form>
  );
}

export function Qty({ name, qty, onChange }: { name: string; qty: number; onChange: (qty: number) => void }) {
  return (
    <span className="pos-qty">
      <Button className="pos-step" aria-label={t("One less {item_name}", { item_name: name })} onClick={() => onChange(qty - 1)}>
        <Minus className="size-4" aria-hidden="true" />
      </Button>
      <input
        className="input pos-qty-box"
        inputMode="decimal"
        aria-label={t("Quantity of {label}", { label: name })}
        value={qty}
        onFocus={(e) => e.target.select()}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
      <Button className="pos-step" aria-label={t("One more {item_name}", { item_name: name })} onClick={() => onChange(qty + 1)}>
        <Plus className="size-4" aria-hidden="true" />
      </Button>
    </span>
  );
}

