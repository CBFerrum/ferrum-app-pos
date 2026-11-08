// The till: a touch-first screen for a cashier with a queue. The scan box is always ready (a
// hardware scanner types into it wherever focus was); a code sells at once from the register's price
// book, which is on the device, and from the server when the book does not know it. The sale on
// screen survives a reload, a basket can be held while the next customer is served, and a sale that
// cannot be sent waits on the device (hooks.ts, lib/pos.ts) and goes when the connection is back, so
// a dropped network never costs a sale. Prices, taxes and totals are the server's (`_calc`), or, while
// it cannot be reached, the server's own engine run on the price book.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudOff, ScanBarcode, Store, WifiOff } from "lucide-react";
import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { docPath, errorMessage, formatDecimal, formatMoment, newKey, shell, t as tr, isolate } from "@ferrum/client";
import { Badge, Button, confirmDialog, ErrorState, Menu, MenuItem, Spinner, toast, useDebounced, useShellTitle, placed } from "@ferrum/kit";
import { LinkInput, type Doc } from "@ferrum/records";
import { CartLines, Totals, type Base } from "./Cart";
import { HeldDialog, KeysDialog } from "./Held";
import { PayDialog, ReceiptDialog } from "./Pay";
import { Currency, fine, localDate, myEmail, num, str, titleOf, useMoney } from "./fmt";
import { useCalc, useOutbox } from "./hooks";
import { loadCart, loadHeld, ownerOf, putAside, saveCart, saveHeld, takeOut, totalOf, type Customer, type HeldSale } from "./lib/held";
import { scanBook, searchBook, serverDown, till, unreachable, type PriceBook } from "./lib/offline";
import { tally } from "./lib/pay";
import { addItem, adjustLine, invoiceBody, keptReceipt, parseScan, setQty, withMethodNames, type CartLine, type QueuedSale, type Tender } from "./lib/pos";
import { rightsOf } from "./lib/rights";
import { denominations } from "./lib/shift";

// Returns need the server, and are not needed to sell: they load when first asked for.
const ReturnDesk = lazy(() => import("./Returns"));

/** A part that failed to load (the connection dropped between asking and getting it) must not take
 *  the sale on screen with it: it is dropped, and the cashier told. */
class Guard extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

interface ListResponse {
  rows: Doc[];
}

const list = (entity: string, query: Record<string, string | number | boolean | undefined>, signal?: AbortSignal) => till<ListResponse>(docPath(entity), { query, signal });

type Dialog = null | "pay" | "held" | "returns" | "keys";

export interface TillProps {
  profile: Doc;
  session: { id: string; number: string };
  modes: Doc[];
  book: PriceBook | null;
  manager: boolean;
  /** The server could not be reached when this register was opened. */
  offline: boolean;
  onSwitch?: () => void;
}

export function Till({ profile, session, modes, book, manager, offline, onSwitch }: TillProps) {
  useShellTitle(tr("Till"));
  const qc = useQueryClient();
  const navigate = useNavigate();
  const email = myEmail();
  const profileId = str(profile.id);
  const owner = ownerOf(profileId, email);
  const precision = book?.engine.precision ?? 2;
  const code = book?.currency || titleOf(profile, "currency");
  const money = useMemo(() => (v: unknown) => formatDecimal(v ?? 0, precision), [precision]);
  const rights = useMemo(() => rightsOf(profile, manager), [profile, manager]);
  const steps = useMemo(() => denominations(code).quick, [code]);

  // The sale in progress and the sales on hold are the device's: they come back after a reload.
  const restored = useMemo(() => loadCart(owner), [owner]);
  const [lines, setLines] = useState<CartLine[]>(restored?.lines ?? []);
  const [customer, setCustomer] = useState<Customer>(restored?.customer ?? { id: null });
  const saleKey = useRef(restored?.key ?? newKey());
  const [held, setHeld] = useState<HeldSale[]>(() => loadHeld(owner));
  const [selected, setSelected] = useState<string | null>(restored?.lines.at(-1)?.key ?? null);
  const [editing, setEditing] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [receipt, setReceipt] = useState<Doc | null>(null);
  const scan = useRef<HTMLInputElement>(null);
  const outbox = useOutbox();
  useEffect(() => {
    saveCart(owner, { lines, customer, key: saleKey.current });
  }, [owner, lines, customer]);

  const focusScan = useCallback(() => {
    if (fine()) scan.current?.focus();
  }, []);
  const anyOpen = dialog !== null || receipt !== null;
  useEffect(() => {
    if (!anyOpen) focusScan();
  }, [anyOpen, focusScan]);

  // ── items ──
  const groups = ((profile.item_groups as Doc[] | undefined) ?? []).map((g) => str(g.item_group)).filter(Boolean);
  const q = useDebounced(search.trim(), 200);
  const items = useQuery({
    queryKey: ["pos", "items", profileId, q],
    queryFn: async ({ signal }) => {
      const fromBook = (): ListResponse => ({ rows: searchBook(book!, q).map((i) => ({ id: i.id, item_code: i.code, item_name: i.name, barcode: i.barcode })) });
      if (book && serverDown()) return fromBook();
      try {
        return await list(
          "Item",
          {
            search: q || undefined,
            fields: "id,item_code,item_name,barcode,standard_rate",
            filters: JSON.stringify({ disabled: false, ...(groups.length ? { item_group: ["in", groups] } : {}) }),
            limit: 30,
            sort: "item_name asc",
          },
          signal,
        );
      } catch (e) {
        if (!unreachable(e) || !book) throw e;
        return fromBook();
      }
    },
    staleTime: 60_000,
    retry: false,
  });
  const priceOf = useMemo(() => new Map((book?.items ?? []).map((i) => [i.id, i.line.price] as const)), [book]);

  // ── totals ──
  const body = useMemo(
    () => (lines.length ? invoiceBody({ profile: profileId, session: session.id, customer: customer.id, lines: lines.map(({ note: _note, ...l }) => l), tenders: [] }) : null),
    [lines, customer.id, profileId, session.id],
  );
  const calc = useCalc(body, lines, book);
  const priced = useMemo(() => (calc.doc?.items as Doc[] | undefined) ?? [], [calc.doc]);
  const grand = num(calc.doc?.grand_total);
  const due = num(calc.doc?.rounded_total ?? calc.doc?.grand_total);
  const ready = lines.length > 0 && !calc.pending && !calc.error && !!calc.doc;
  const walkIn = !customer.id || customer.id === str(profile.customer);
  const away = offline || !!calc.offline;

  // What each line was priced from (the list price and the rule's discount), learned from lines the
  // cashier has not changed, else from the price book: the cap on a discount is measured against it.
  const learned = useRef(new Map<string, Base>());
  useEffect(() => {
    lines.forEach((l, i) => {
      const p = priced[i];
      if (!p || p.item !== l.item || l.price || l.discount) return;
      learned.current.set(l.item, { list: num(p.price_list_rate), rule: num(p.discount_percent) });
    });
  }, [priced, lines]);
  const baseOf = (l: CartLine): Base | null => {
    const known = learned.current.get(l.item);
    if (known && known.list > 0) return known;
    const b = book?.items.find((i) => i.id === l.item);
    return b ? { list: num(b.line.price), rule: num(b.line.discount_percent) } : null;
  };

  // ── changing the sale ──
  const add = useCallback((item: { id: string; name: string }, qty = 1) => {
    setLines((l) => addItem(l, item, qty));
    setSelected(item.id);
  }, []);
  const clearSale = useCallback(() => {
    setLines([]);
    setCustomer({ id: null });
    setSelected(null);
    setEditing(null);
    setSearch("");
    saleKey.current = newKey();
  }, []);
  const changeQty = (key: string, qty: number) => setLines((l) => setQty(l, key, qty));
  const remove = (key: string) => {
    setLines((l) => l.filter((x) => x.key !== key));
    setEditing(null);
    setSelected(null);
  };

  // A scan: the price book answers at once; the server is asked when it does not know the code.
  const onScan = async (e: FormEvent) => {
    e.preventDefault();
    const { qty, code: text } = parseScan(search);
    if (!text) return;
    const hit = book ? scanBook(book, text) : null;
    if (hit) {
      add({ id: hit.item.id, name: hit.item.name || hit.item.code }, hit.qty * qty);
      setSearch("");
      return;
    }
    if (serverDown()) {
      toast(book ? tr("Nothing on this device matches “{text}”", { text }) : tr("No connection, and no prices on this device yet."), "error");
      return;
    }
    try {
      const packs = await list("ItemBarcode", { filters: JSON.stringify({ barcode: text }), fields: "id,item,qty", titles: true, limit: 1 });
      const pack = packs.rows[0];
      if (pack) {
        add({ id: str(pack.item), name: titleOf(pack, "item") }, (num(pack.qty) || 1) * qty);
        setSearch("");
        return;
      }
      const found = await list("Item", { search: text, fields: "id,item_code,item_name,barcode", filters: JSON.stringify({ disabled: false }), limit: 10 });
      const exact = found.rows.filter((r) => str(r.barcode) === text || str(r.item_code).toLowerCase() === text.toLowerCase());
      const one = exact.length === 1 ? exact[0] : found.rows.length === 1 ? found.rows[0] : undefined;
      if (one) {
        add({ id: str(one.id), name: str(one.item_name) || str(one.item_code) }, qty);
        setSearch("");
      } else if (!found.rows.length) toast(tr("Nothing matches “{text}”", { text }), "error");
    } catch (err) {
      toast(unreachable(err) ? tr("No connection, and nothing on this device matches.") : errorMessage(err), "error");
    }
  };

  // ── hold and resume ──
  const now = () => new Date().toISOString();
  const hold = () => {
    if (!lines.length) return;
    const next = putAside(held, { lines, customer, key: saleKey.current }, now(), totalOf(calc.doc));
    if (!saveHeld(owner, next)) return void toast(tr("This device could not keep the sale aside: its storage is full or blocked."), "error");
    setHeld(next);
    clearSale();
    toast(tr("Sale put on hold"));
    focusScan();
  };
  const resume = async (key: string) => {
    const { sale, rest } = takeOut(held, key);
    if (!sale) return;
    let next = rest;
    if (lines.length) {
      const ok = await confirmDialog({
        title: tr("Put the sale on screen on hold?"),
        message: (lines.length === 1 ? tr("It has {length} line. It will be held, and the one you picked brought back.", { length: lines.length }) : tr("It has {length} lines. It will be held, and the one you picked brought back.", { length: lines.length })),
        confirmLabel: tr("Hold it and resume"),
        cancelLabel: tr("Keep it"),
      });
      if (!ok) return;
      next = putAside(rest, { lines, customer, key: saleKey.current }, now(), totalOf(calc.doc));
    }
    if (!saveHeld(owner, next)) return void toast(tr("This device could not keep the sales on hold: its storage is full or blocked."), "error");
    setHeld(next);
    setLines(sale.lines);
    setCustomer(sale.customer);
    setSelected(sale.lines.at(-1)?.key ?? null);
    saleKey.current = sale.key;
    setDialog(null);
  };
  const discard = async (key: string) => {
    const sale = held.find((s) => s.key === key);
    if (!sale) return;
    const ok = await confirmDialog({ title: tr("Discard this held sale?"), message: (sale.lines.length === 1 ? tr("{length} line will be forgotten.", { length: sale.lines.length }) : tr("{length} lines will be forgotten.", { length: sale.lines.length })), confirmLabel: tr("Discard"), danger: true });
    if (!ok) return;
    const { rest } = takeOut(held, key);
    if (saveHeld(owner, rest)) setHeld(rest);
  };

  // ── selling ──
  const complete = async (tenders: Tender[]): Promise<string | null> => {
    const at = new Date();
    // When it was sold, not when it reaches the server. The sale has its own id, made when it began.
    const sale: Doc = {
      ...invoiceBody({ id: saleKey.current, profile: profileId, session: session.id, customer: customer.id, lines, tenders }),
      posting_date: localDate(at),
      posting_time: at.toTimeString().slice(0, 8),
    };
    const key = saleKey.current;
    const keep = (): string | null => {
      const queued: QueuedSale = { key, body: sale, at: at.toISOString(), by: email, total: String(due) };
      // The sale is the device's only copy: if the device would not keep it, it stays on screen.
      if (!outbox.add(queued)) return tr("This device could not keep the sale: its storage is full or blocked. Connect to send it now, or free some space and try again.");
      const paid = tenders.map((t) => ({ kind: str(modes.find((m) => m.id === t.mode_of_payment)?.mode_type), amount: num(t.amount) }));
      const change = tally(due, paid, num(profile.write_off_limit), precision).change;
      // A receipt now, marked as not yet sent; the server numbers the sale when it arrives.
      setReceipt(keptReceipt(profile, calc.doc, sale, { customer: customer.title, due, change }));
      clearSale();
      setDialog(null);
      return null;
    };
    if (calc.offline || serverDown()) return keep();
    try {
      const done = await till<Doc>(docPath("PosInvoice"), { method: "POST", body: sale, query: { submit: true }, idempotencyKey: key });
      setReceipt(withMethodNames(profile, done));
      void qc.invalidateQueries({ queryKey: ["list", "PosInvoice"] });
      clearSale();
      setDialog(null);
      return null;
    } catch (err) {
      if (!unreachable(err)) return errorMessage(err);
      return keep();
    }
  };

  // The end of a shift is read from the server (what the register expects), so it waits for a connection.
  const shift = (to: string) => (away || serverDown() ? toast(tr("Closing the shift needs a connection: the register's figures are the server's."), "error") : navigate(to));
  const openReturns = () => {
    if (away || serverDown()) return void toast(tr("Returns need a connection: the sale being returned is read from the server."), "error");
    setDialog("returns");
  };

  // ── the keyboard ──
  const latest = useRef({ lines, selected, editing, ready, dialog: anyOpen });
  latest.current = { lines, selected, editing, ready, dialog: anyOpen };
  const act = useRef({ hold, openReturns, remove, changeQty });
  act.current = { hold, openReturns, remove, changeQty };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
      const s = latest.current;
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName));
      const open = s.dialog || !!document.querySelector("dialog[open]");
      if (open) return;
      const emptyScan = target === scan.current && !scan.current?.value;
      const go = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      switch (e.key) {
        case "F2":
          return go(() => scan.current?.focus());
        case "F3":
          return go(() => s.selected && setEditing((c) => (c === s.selected ? null : s.selected)));
        case "F4":
          return go(() => s.ready && setDialog("pay"));
        case "F9":
          return go(() => act.current.hold());
        case "F10":
          return go(() => setDialog("held"));
        case "F8":
          return go(() => act.current.openReturns());
        case "Escape":
          return go(() => {
            setEditing(null);
            scan.current?.focus();
          });
      }
      if (emptyScan || !typing) {
        const at = s.lines.findIndex((l) => l.key === s.selected);
        const line = s.lines[at];
        if (e.key === "ArrowDown" && s.lines.length) return go(() => setSelected(s.lines[Math.min(at + 1, s.lines.length - 1)]?.key ?? s.lines[0].key));
        if (e.key === "ArrowUp" && s.lines.length) return go(() => setSelected(s.lines[Math.max(at - 1, 0)].key));
        if (line && e.key === "Delete") return go(() => act.current.remove(line.key));
        if (line && e.key === "+") return go(() => act.current.changeQty(line.key, line.qty + 1));
        if (line && e.key === "-") return go(() => line.qty > 1 && act.current.changeQty(line.key, line.qty - 1));
      }
      // A scanner types wherever focus was: send it to the scan box, and the code goes in.
      if (!typing && e.key.length === 1 && e.key !== " ") scan.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pending = outbox.queued.filter(outbox.mine).length;
  const view = (
    <div className="pos">
      <header className="pos-head">
        <Store className="size-5 text-muted-foreground" aria-hidden="true" />
        <h1>{isolate(str(profile.profile_name))}</h1>
        <Badge>{session.number ? tr("Session {number}", { number: session.number }) : tr("Session open")}</Badge>
        {away ? (
          <Badge tone="amber" title={tr("Selling from this device; sales are sent when the connection is back")}>
            <CloudOff className="size-3.5" aria-hidden="true" /> {tr("Offline")}
          </Badge>
        ) : (
          pending > 0 && (
            <Badge tone="amber">
              <WifiOff className="size-3.5" aria-hidden="true" /> {tr("{pending} to send", { pending })}
            </Badge>
          )
        )}
        <span className="spacer" />
        <Button className="pos-btn" onClick={() => setDialog("held")}>
          {tr("On hold")}
          {held.length > 0 && <Badge tone="blue">{held.length}</Badge>}
        </Button>
        <Button className="pos-btn" onClick={openReturns} title={away ? tr("Returns need a connection") : undefined}>
          {tr("Return")}
        </Button>
        <Menu label={tr("Shift")} buttonClass="btn btn-default btn-md pos-btn">
          {(close) => (
            <>
              <MenuItem onSelect={() => (close(), shift("/shift"))}>{tr("Count the drawer and close the shift")}</MenuItem>
              <MenuItem onSelect={() => (close(), shift("/shift#cash"))}>{tr("Cash in or out")}</MenuItem>
              {onSwitch && (
                <MenuItem
                  onSelect={() => {
                    close();
                    onSwitch();
                  }}
                >
                  {tr("Switch register")}
                </MenuItem>
              )}
            </>
          )}
        </Menu>
        <Button className="pos-btn" aria-label={tr("Keyboard shortcuts")} title={tr("Keyboard shortcuts")} onClick={() => setDialog("keys")}>
          ?
        </Button>
      </header>

      <section className="pos-items" aria-label={tr("Items")}>
        <form onSubmit={onScan} className="pos-scan">
          <div className="pos-scan-box">
            <ScanBarcode className="pos-scan-icon" aria-hidden="true" />
            <input
              ref={scan}
              className="input"
              autoFocus={fine()}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tr("Scan a barcode or search items")}
              aria-label={tr("Scan a barcode or search items")}
              aria-keyshortcuts="F2"
            />
          </div>
          <Button type="submit" className="pos-btn">
            {tr("Add")}
          </Button>
        </form>
        {outbox.queued.length > 0 && <OutboxBar queued={outbox.queued} mine={outbox.mine} signedOut={outbox.signedOut} onSend={() => void outbox.flush()} onRetry={outbox.retry} onDiscard={outbox.discard} />}
        {items.error ? (
          <ErrorState error={items.error} onRetry={() => void items.refetch()} />
        ) : (
          <ul className="pos-tiles">
            {items.isLoading && Array.from({ length: 8 }, (_, i) => <li key={i} className="pos-tile skeleton" aria-hidden="true" />)}
            {(items.data?.rows ?? []).map((r) => (
              <li key={str(r.id)}>
                <button type="button" className="pos-tile" onClick={() => add({ id: str(r.id), name: str(r.item_name) || str(r.item_code) })}>
                  <span className="pos-tile-name">{str(r.item_name) || str(r.item_code)}</span>
                  <span className="pos-tile-meta">
                    <span className="faint">{isolate(str(r.item_code))}</span>
                    {priceOf.has(str(r.id)) && <strong>{isolate(money(priceOf.get(str(r.id))))}</strong>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {items.data && !items.data.rows.length && <p className="muted">{q ? tr("No items match “{q}”.", { q }) : tr("No items to show.")}</p>}
      </section>

      <section className="pos-sale" aria-label={tr("Sale")}>
        <LinkInput to="Customer" value={customer.id} title={customer.title} onChange={(id, title) => setCustomer({ id, title })} label={tr("Customer")} placeholder={titleOf(profile, "customer") || tr("Walk-in customer")} />
        {lines.length === 0 ? (
          <p className="pos-empty">{tr("Scan or tap items to start a sale.")}</p>
        ) : (
          <CartLines
            lines={lines}
            priced={priced}
            pending={calc.pending}
            selected={selected}
            editing={editing}
            rights={rights}
            baseOf={baseOf}
            onSelect={setSelected}
            onEdit={setEditing}
            onQty={changeQty}
            onChange={(key, patch) => setLines((l) => adjustLine(l, key, patch))}
            onRemove={remove}
          />
        )}
        {calc.error && (
          <p role="alert" className="pos-error">
            {isolate(calc.error)}
          </p>
        )}
        {calc.pending && lines.length > 0 && !calc.doc && (
          <p className="muted">
            <Spinner small /> {tr("Pricing…")}
          </p>
        )}
        {calc.doc && lines.length > 0 && <Totals doc={calc.doc} due={due} offline={calc.offline} builtAt={book?.built_at} />}
        <div className="pos-actions">
          <Button className="pos-btn" disabled={!lines.length} onClick={hold} aria-keyshortcuts="F9">
            {tr("Hold")}
          </Button>
          <Button className="pos-btn" disabled={!lines.length} onClick={clearSale}>
            {tr("Clear")}
          </Button>
          <Button variant="primary" className="pos-btn pos-pay" disabled={!ready} onClick={() => setDialog("pay")} aria-keyshortcuts="F4">
            {calc.pending && lines.length ? tr("Pricing…") : ready ? tr("Pay {due}", { due: money(due) }) : tr("Pay")}
          </Button>
        </div>
      </section>

      {lines.length > 0 && (
        // Phones: the sale panel is below the items, so the total and Pay stay in reach.
        <div className="pos-bar">
          <span>
            {lines.length} {lines.length === 1 ? tr("line") : tr("lines")}
            {ready && <strong>{isolate(money(due))}</strong>}
          </span>
          <Button variant="primary" className="pos-btn" disabled={!ready} onClick={() => setDialog("pay")}>
            {calc.pending ? tr("Pricing…") : tr("Pay")}
          </Button>
        </div>
      )}

      {dialog === "pay" && (
        <PayDialog
          profile={profile}
          modes={modes}
          due={due}
          grand={grand}
          walkIn={walkIn}
          customer={customer.id}
          program={str(calc.doc?.loyalty_program) || null}
          offline={away || serverDown()}
          steps={steps}
          onClose={() => setDialog(null)}
          onComplete={complete}
        />
      )}
      {dialog === "held" && <HeldDialog held={held} onResume={(k) => void resume(k)} onDiscard={(k) => void discard(k)} onClose={() => setDialog(null)} />}
      {dialog === "keys" && <KeysDialog onClose={() => setDialog(null)} />}
      {dialog === "returns" && (
        <Guard
          onError={() => {
            toast(tr("Returns could not be loaded. Check the connection and try again."), "error");
            setDialog(null);
          }}
        >
          <Suspense fallback={null}>
            <ReturnDesk
              profile={profile}
              session={session.id}
              onClose={() => setDialog(null)}
              onDone={(done) => {
                setDialog(null);
                setReceipt(done);
              }}
            />
          </Suspense>
        </Guard>
      )}
      {receipt && <ReceiptDialog profile={profile} sale={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
  return <Currency.Provider value={{ precision, code }}>{view}</Currency.Provider>;
}

function OutboxBar({
  queued,
  mine,
  signedOut,
  onSend,
  onRetry,
  onDiscard,
}: {
  queued: QueuedSale[];
  mine: (s: QueuedSale) => boolean;
  signedOut: boolean;
  onSend: () => void;
  onRetry: (k: string) => void;
  onDiscard: (k: string) => void;
}) {
  const money = useMoney();
  const refused = queued.filter((s) => s.error && mine(s));
  const others = queued.filter((s) => !mine(s));
  const own = queued.length - others.length;
  return (
    <div role="status" className="pos-outbox">
      {own > 0 && (
        <div className="pos-outbox-row">
          <WifiOff className="size-4" aria-hidden="true" />
          <span className="pos-outbox-text">
            {(own === 1 ? (signedOut ? tr("1 sale is kept on this device until you sign in again") : tr("1 sale is kept on this device until they can be sent")) : (signedOut ? tr("{own} sales are kept on this device until you sign in again", { own }) : tr("{own} sales are kept on this device until they can be sent", { own })))}.
          </span>
          {signedOut ? (
            <Button onClick={() => shell().session.reauthenticate()}>{tr("Sign in to send")}</Button>
          ) : (
            <Button onClick={onSend}>{tr("Send now")}</Button>
          )}
        </div>
      )}
      {others.length > 0 && (
        <p className="pos-outbox-row">
          {placed(tr("{p1} by {value} will be sent when they sign in on this device."), { p1: others.length === 1 ? tr("1 sale") : tr("{length} sales", { length: others.length }), value: [...new Set(others.map((s) => s.by))].join(", ") })}
        </p>
      )}
      {refused.map((s) => (
        <div key={s.key} className="pos-outbox-row">
          <span className="pos-outbox-text">
            {tr("Sale of")} {isolate(formatMoment(s.at, { timeStyle: "medium" }))}
            {s.total ? ` (${money(s.total)})` : ""} {tr("was refused: {error}", { error: s.error ?? "" })}
          </span>
          <Button onClick={() => onRetry(s.key)}>{tr("Retry")}</Button>
          <Button variant="ghost" onClick={() => onDiscard(s.key)}>
            {tr("Discard")}
          </Button>
        </div>
      ))}
    </div>
  );
}
