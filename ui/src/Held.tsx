// Sales set aside at this till, to serve the next customer first. They live on this device (so
// they work offline and cost the server nothing), per register and cashier; resuming one brings
// its lines and customer back, and re-prices them, so a price that changed meanwhile is the new one.

import { formatMoment, t, isolate } from "@ferrum/client";
import { Button, Dialog, StatePanel } from "@ferrum/kit";
import { useMoney } from "./fmt";
import { heldSummary, type HeldSale } from "./lib/held";

export function HeldDialog({ held, onResume, onDiscard, onClose }: { held: HeldSale[]; onResume: (key: string) => void; onDiscard: (key: string) => void; onClose: () => void }) {
  const money = useMoney();
  return (
    <Dialog open onClose={onClose} title={t("Sales on hold")} footer={<Button onClick={onClose}>{t("Close")}</Button>}>
      {held.length === 0 ? (
        <StatePanel kind="empty" title={t("Nothing on hold")}>
          {t("Press Hold to set a sale aside while you serve someone else.")}
        </StatePanel>
      ) : (
        <ul className="pos-held">
          {held.map((s) => {
            const { who, lines } = heldSummary(s);
            return (
              <li key={s.key}>
                <div className="pos-held-main">
                  <strong>{isolate(who)}</strong>
                  <span className="muted">
                    {isolate(lines)} · {isolate(formatMoment(s.at, { hour: "numeric", minute: "2-digit" }))}
                    {s.total ? ` · ${money(s.total)}` : ""}
                  </span>
                  <span className="faint pos-held-items">{isolate(s.lines.map((l) => `${l.qty} × ${l.item_name}`).join(", "))}</span>
                </div>
                <Button variant="primary" className="pos-btn" onClick={() => onResume(s.key)}>
                  {t("Resume")}
                </Button>
                <Button variant="danger" className="pos-btn" aria-label={t("Discard the sale of {who}", { who })} onClick={() => onDiscard(s.key)}>
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

/** The keyboard's keys, each with what it does in the page's language. */
const keys = (): [string, string][] => [
  ["F2", t("Go to the scan box")],
  ["3*code", t("Scan three of that code")],
  ["↑ ↓", t("Pick a line (scan box empty)")],
  ["+ −", t("One more or one less of the picked line")],
  ["F3", t("Change the picked line: quantity, discount, note")],
  [t("Delete"), t("Remove the picked line (scan box empty)")],
  ["F4", t("Take payment")],
  ["F9", t("Hold this sale")],
  ["F10", t("Sales on hold")],
  ["F8", t("Returns")],
  [t("Enter"), t("In the pay window: add the payment, or finish the sale")],
  [t("Esc"), t("Close what is open, back to the scan box")],
];

export function KeysDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title={t("Keyboard")} footer={<Button onClick={onClose}>{t("Close")}</Button>}>
      <dl className="pos-keys">
        {keys().map(([k, what]) => (
          <div key={k}>
            <dt>
              <kbd>{isolate(k)}</kbd>
            </dt>
            <dd>{isolate(what)}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
