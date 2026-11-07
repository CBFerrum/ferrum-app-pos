// Sales set aside at this till, to serve the next customer first. They live on this device (so
// they work offline and cost the server nothing), per register and cashier; resuming one brings
// its lines and customer back, and re-prices them, so a price that changed meanwhile is the new one.

import { formatMoment, t } from "@ferrum/client";
import { Button, Dialog, EmptyState } from "@ferrum/kit";
import { useMoney } from "./fmt";
import { heldSummary, type HeldSale } from "./lib/held";

export function HeldDialog({ held, onResume, onDiscard, onClose }: { held: HeldSale[]; onResume: (key: string) => void; onDiscard: (key: string) => void; onClose: () => void }) {
  const money = useMoney();
  return (
    <Dialog open onClose={onClose} title={t("Sales on hold")} footer={<Button onClick={onClose}>{t("Close")}</Button>}>
      {held.length === 0 ? (
        <EmptyState title={t("Nothing on hold")} icon="list">
          {t("Press Hold to set a sale aside while you serve someone else.")}
        </EmptyState>
      ) : (
        <ul className="pos-held">
          {held.map((s) => {
            const { who, lines } = heldSummary(s);
            return (
              <li key={s.key}>
                <div className="pos-held-main">
                  <strong>{who}</strong>
                  <span className="muted">
                    {lines} · {formatMoment(s.at, { hour: "numeric", minute: "2-digit" })}
                    {s.total ? ` · ${money(s.total)}` : ""}
                  </span>
                  <span className="faint pos-held-items">{s.lines.map((l) => `${l.qty} × ${l.item_name}`).join(", ")}</span>
                </div>
                <Button variant="primary" onClick={() => onResume(s.key)}>
                  {t("Resume")}
                </Button>
                <Button variant="danger" aria-label={`Discard the sale of ${who}`} onClick={() => onDiscard(s.key)}>
                  {t("Discard")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}

const KEYS: [string, string][] = [
  ["F2", "Go to the scan box"],
  ["3*code", "Scan three of that code"],
  ["↑ ↓", "Pick a line (scan box empty)"],
  ["+ −", "One more or one less of the picked line"],
  ["F3", "Change the picked line: quantity, discount, note"],
  ["Delete", "Remove the picked line (scan box empty)"],
  ["F4", "Take payment"],
  ["F9", "Hold this sale"],
  ["F10", "Sales on hold"],
  ["F8", "Returns"],
  ["Enter", "In the pay window: add the payment, or finish the sale"],
  ["Esc", "Close what is open, back to the scan box"],
];

export function KeysDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title={t("Keyboard")} footer={<Button onClick={onClose}>{t("Close")}</Button>}>
      <dl className="pos-keys">
        {KEYS.map(([k, what]) => (
          <div key={k}>
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
