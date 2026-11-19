// The chooser behind a template's tile (POS-11): every variant of it the price book holds, by name, with its code and,
// where the till knows it, its price. The first has the focus; Up and Down move; Enter chooses; Escape closes.

import { isolate, t } from "@ferrum/client";
import { Button, Dialog } from "@ferrum/kit";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useMoney } from "./fmt";
import { listPrices, type BookItem, type PriceBook } from "./lib/offline";
import { shortName, variantsOf } from "./lib/variants";

export function VariantDialog({
  book,
  template,
  name,
  onChoose,
  onClose,
}: {
  book: PriceBook;
  template: string;
  /** The template's name, as its tile shows it. */
  name: string;
  onChoose: (variant: BookItem) => void;
  onClose: () => void;
}) {
  const money = useMoney();
  const variants = variantsOf(book, template);
  // The names show at once; the prices when the book has worked them out.
  const [prices, setPrices] = useState<Map<string, { list: string }>>(new Map());
  useEffect(() => {
    let live = true;
    void listPrices(book, variantsOf(book, template).map((v) => v.id)).then((m) => live && setPrices(m));
    return () => {
      live = false;
    };
  }, [book, template]);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (e: KeyboardEvent, i: number) => {
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    buttons.current[(i + step + variants.length) % variants.length]?.focus();
  };
  return (
    <Dialog open onClose={onClose} title={t("Choose one of {name}", { name })} footer={<Button onClick={onClose}>{t("Close")}</Button>}>
      <ul className="pos-tiles">
        {variants.map((v, i) => (
          <li key={v.id}>
            <button
              ref={(el) => {
                buttons.current[i] = el;
              }}
              type="button"
              className="pos-tile"
              data-autofocus={i === 0 ? "" : undefined}
              onKeyDown={(e) => move(e, i)}
              onClick={() => onChoose(v)}
            >
              <span className="pos-tile-name">{isolate(shortName(v.name, name))}</span>
              <span className="pos-tile-meta">
                <span className="faint">{isolate(v.code)}</span>
                {prices.has(v.id) && <strong>{isolate(money(prices.get(v.id)?.list))}</strong>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
