// The register: a touch-first till for cashiers. Pick a register, open a session with its float,
// scan or tap items, take one or more tenders and print the receipt. Prices, taxes and totals come
// from the server (`_calc`), or, while it cannot be reached, from the register's price book with
// the server's own engine (lib/offline.ts). Each sale is created and submitted in one request with
// an idempotency key; one that cannot be sent waits in an outbox (lib/pos.ts) with the person who
// made it, and goes when the connection — or their session — is back, so a retry never sells twice.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudOff, Minus, Plus, Printer, ScanBarcode, Store, Trash2, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { bootstrap, docPath, errorMessage, formatDecimal, newKey, shell } from "@ferrum/client";
import { cn, EmptyState, ErrorState, toast, useDebounced } from "@ferrum/kit";
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Skeleton } from "@ferrum/kit/primitives";
import { LinkInput, type Doc } from "@ferrum/records";
import {
  downloadBook,
  knownRegisters,
  loadBook,
  priceOffline,
  recallTill,
  rememberTill,
  saveBook,
  scanBook,
  searchBook,
  till,
  unreachable,
  type PriceBook,
  type TillMemory,
} from "./lib/offline";
import {
  addItem,
  balance,
  flushOutbox,
  invoiceBody,
  loadOutbox,
  quickCash,
  receiptHtml,
  saveOutbox,
  setQty,
  type CartLine,
  type QueuedSale,
  type Tender,
} from "./lib/pos";

const PROFILE_KEY = "ferrum.pos.profile";
const TAP = "pointer-coarse:min-h-11";
/** How old a price book may get before the till fetches it again (while online). */
const BOOK_AGE_MS = 30 * 60_000;

interface ListResponse {
  rows: Doc[];
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown) => Number(v ?? 0) || 0;
const money = (v: unknown) => formatDecimal(v ?? 0, 2);
const titleOf = (d: Doc | undefined, field: string) => str((d?._titles as Record<string, unknown> | undefined)?.[field]) || str(d?.[field]);
/** The person at the till, from the page (it works offline, unlike asking the server). */
const myEmail = () => bootstrap()?.person?.email ?? "";

function remembered(): string | null {
  try {
    return localStorage.getItem(PROFILE_KEY);
  } catch {
    return null;
  }
}

function remember(id: string) {
  try {
    localStorage.setItem(PROFILE_KEY, id);
  } catch {
    // a private window: the cashier picks again next time
  }
}

const list = (entity: string, query: Record<string, string | number | boolean | undefined>, signal?: AbortSignal) =>
  till<ListResponse>(docPath(entity), { query, signal });

export function RegisterPage() {
  const email = myEmail();
  const profiles = useQuery({
    queryKey: ["pos", "profiles"],
    queryFn: ({ signal }) => list("PosProfile", { filters: JSON.stringify({ disabled: false }), fields: "id,profile_name", limit: 200, sort: "profile_name asc" }, signal),
    retry: false,
  });
  const [chosen, setChosen] = useState<string | null>(remembered);
  // Offline: the registers this device has worked.
  const offline = !!profiles.error && unreachable(profiles.error);
  const rows = profiles.data?.rows ?? (offline ? knownRegisters(email) : []);
  const profileId = rows.some((r) => r.id === chosen) ? chosen : rows.length === 1 ? str(rows[0].id) : null;

  if (profiles.isLoading) return <Skeleton className="m-4 h-64" />;
  if (profiles.error && !offline) return <ErrorState error={profiles.error} onRetry={() => void profiles.refetch()} />;
  if (!rows.length) {
    return offline ? (
      <EmptyState title="No connection">This device has not opened a register yet: connect once to set it up for working offline.</EmptyState>
    ) : (
      <EmptyState title="No registers yet">
        <Link to="/e/PosProfile/new">Set up a POS profile</Link> for this shop first.
      </EmptyState>
    );
  }
  if (!profileId) {
    return (
      <div className="mx-auto grid max-w-md gap-3 p-4">
        <h1 className="text-lg font-semibold">Choose a register</h1>
        {rows.map((r) => (
          <Button
            key={str(r.id)}
            variant="outline"
            className={cn("justify-start", TAP)}
            onClick={() => {
              remember(str(r.id));
              setChosen(str(r.id));
            }}
          >
            <Store /> {str(r.profile_name)}
          </Button>
        ))}
      </div>
    );
  }
  return <Register key={profileId} profileId={profileId} onSwitch={rows.length > 1 ? () => setChosen(null) : undefined} />;
}

/** The register's price book: from this device at once, then fetched again while online when it
 *  is older than half an hour or the session changed. */
function usePriceBook(profileId: string, session: string | null) {
  const [book, setBook] = useState<PriceBook | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const kept = await loadBook(profileId).catch(() => null);
      if (live && kept) setBook(kept);
      if (!session || (kept && Date.now() - Date.parse(kept.built_at) < BOOK_AGE_MS)) return;
      try {
        const fresh = await downloadBook(profileId, (after) => till(`/api/app/pos/pricebook`, { query: { profile: profileId, after: after ?? undefined } }));
        if (!live) return;
        setBook(fresh);
        await saveBook(fresh).catch(() => {});
      } catch {
        // offline or refused: the kept book (if any) prices sales until the next try
      }
    })();
    return () => {
      live = false;
    };
  }, [profileId, session]);
  return book;
}

function Register({ profileId, onSwitch }: { profileId: string; onSwitch?: () => void }) {
  const email = myEmail();
  const memory = useMemo(() => recallTill(profileId, email), [profileId, email]);
  const profile = useQuery({
    queryKey: ["pos", "profile", profileId],
    queryFn: ({ signal }) => till<Doc>(docPath("PosProfile", profileId), { query: { titles: true }, signal }),
    retry: false,
  });
  const session = useQuery({
    queryKey: ["pos", "session", profileId, email],
    queryFn: ({ signal }) =>
      list("PosOpeningEntry", { filters: JSON.stringify({ pos_profile: profileId, status: "Open", user: email }), fields: "id,number,period_start", limit: 1 }, signal),
    enabled: !!email,
    retry: false,
  });
  const modes = useQuery({
    queryKey: ["pos", "modes"],
    queryFn: ({ signal }) => list("ModeOfPayment", { fields: "id,mode_name,mode_type", limit: 200 }, signal),
    staleTime: 300_000,
    retry: false,
  });
  // What the server says, else (offline) what this device last knew.
  const offline = [profile.error, session.error].some((e) => e && unreachable(e));
  const profileDoc = profile.data ?? (offline ? memory?.profile : undefined);
  const open = session.data ? (session.data.rows[0] ? { id: str(session.data.rows[0].id), number: str(session.data.rows[0].number) } : null) : offline ? (memory?.session ?? null) : null;
  const modeRows = modes.data?.rows ?? memory?.modes ?? [];
  useEffect(() => {
    if (profile.data && session.data) rememberTill({ email, profile: profile.data, session: open, modes: modes.data?.rows ?? memory?.modes ?? [] } satisfies TillMemory);
  }, [profile.data, session.data, modes.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const book = usePriceBook(profileId, open?.id ?? null);

  if ((profile.isLoading || session.isLoading) && !memory) return <Skeleton className="m-4 h-64" />;
  if (!email) return <ErrorState error={new Error("Sign in to use the register")} />;
  const error = offline ? null : (profile.error ?? session.error);
  if (error || !profileDoc) return <ErrorState error={error ?? new Error("This register is not on this device yet: connect once to set it up.")} onRetry={() => void Promise.all([profile.refetch(), session.refetch()])} />;
  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <Store className="size-5 text-muted-foreground" aria-hidden="true" />
      <h1 className="text-lg font-semibold">{str(profileDoc.profile_name)}</h1>
      {open && <Badge variant="secondary">Session {open.number || "open"}</Badge>}
      {offline && (
        <Badge variant="outline" className="gap-1 border-amber-400 text-amber-800 dark:text-amber-200">
          <CloudOff className="size-3.5" aria-hidden="true" /> Offline
        </Badge>
      )}
      {onSwitch && (
        <Button variant="ghost" size="sm" onClick={onSwitch}>
          Switch register
        </Button>
      )}
      {open && !offline && (
        <Button asChild variant="ghost" size="sm" className="ml-auto">
          <Link to={`/e/PosClosingEntry/new?pos_opening_entry=${encodeURIComponent(open.id)}`}>Close register</Link>
        </Button>
      )}
    </div>
  );
  return (
    <div className="grid gap-3 p-3 md:p-4">
      {header}
      {open ? (
        <Till profile={profileDoc} sessionId={open.id} modes={modeRows} book={book} />
      ) : offline ? (
        <EmptyState title="No open session on this device">Open the register while connected; it then keeps selling offline.</EmptyState>
      ) : (
        <OpenSession profile={profileDoc} onOpened={() => void session.refetch()} />
      )}
    </div>
  );
}

function OpenSession({ profile, onOpened }: { profile: Doc; onOpened: () => void }) {
  const modes = (profile.payments as Doc[] | undefined) ?? [];
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const balance_details = modes.map((m) => ({ mode_of_payment: m.mode_of_payment, opening_amount: amounts[str(m.mode_of_payment)] || "0" }));
      await till(docPath("PosOpeningEntry"), { method: "POST", body: { pos_profile: profile.id, balance_details }, query: { submit: true }, idempotencyKey: key.current });
      toast("Register open");
      onOpened();
    } catch (err) {
      toast(unreachable(err) ? "No connection: open the register when it is back." : errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mx-auto grid w-full max-w-md gap-4 rounded-lg border bg-card p-4">
      <div>
        <h2 className="font-semibold">Open the register</h2>
        <p className="text-sm text-muted-foreground">Count the float in the drawer for each way of paying.</p>
      </div>
      {modes.map((m) => {
        const id = `open-${str(m.mode_of_payment)}`;
        return (
          <div key={id} className="grid gap-1.5">
            <Label htmlFor={id}>{titleOf(m, "mode_of_payment")}</Label>
            <Input
              id={id}
              inputMode="decimal"
              placeholder="0.00"
              value={amounts[str(m.mode_of_payment)] ?? ""}
              onChange={(e) => setAmounts((a) => ({ ...a, [str(m.mode_of_payment)]: e.target.value }))}
            />
          </div>
        );
      })}
      <Button type="submit" disabled={busy} className={TAP}>
        {busy ? "Opening…" : "Open register"}
      </Button>
    </form>
  );
}

interface Calc {
  doc: Doc | null;
  error?: string;
  pending: boolean;
  /** Priced on this device from the price book. */
  offline?: boolean;
}

/** Live totals for the cart: from the server, else (unreachable) from the price book; the newest
 *  request wins. */
function useCalc(body: Doc | null, lines: CartLine[], book: PriceBook | null): Calc {
  const [state, setState] = useState<Calc>({ doc: null, pending: false });
  const debounced = useDebounced(body, 250);
  useEffect(() => {
    if (!debounced) {
      setState({ doc: null, pending: false });
      return;
    }
    const ctl = new AbortController();
    setState((s) => ({ ...s, pending: true }));
    till<Doc>(docPath("PosInvoice", "_calc"), { method: "POST", body: debounced, signal: ctl.signal })
      .then((doc) => setState({ doc, pending: false }))
      .catch(async (e: unknown) => {
        if (ctl.signal.aborted) return;
        if (!unreachable(e)) return setState((s) => ({ doc: s.doc, pending: false, error: errorMessage(e) }));
        if (!book) return setState({ doc: null, pending: false, error: "No connection, and no prices on this device yet." });
        try {
          const doc = await priceOffline(book, lines);
          if (!ctl.signal.aborted) setState({ doc, pending: false, offline: true });
        } catch (err) {
          if (!ctl.signal.aborted) setState({ doc: null, pending: false, error: errorMessage(err) });
        }
      });
    return () => ctl.abort();
  }, [debounced, book]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

/** The outbox, kept in step with storage, sent whenever the connection is back. Only the sales of
 *  the person signed in go out (each is sent in its maker's name); a 401 stops sending until they
 *  sign in again. */
function useOutbox() {
  const email = myEmail();
  const [queued, setQueued] = useState<QueuedSale[]>(loadOutbox);
  const [signedOut, setSignedOut] = useState(false);
  const busy = useRef(false);
  const update = useCallback((next: QueuedSale[]) => {
    saveOutbox(next);
    setQueued(next);
  }, []);
  const mine = useCallback((s: QueuedSale) => !s.by || s.by === email, [email]);
  const flush = useCallback(async () => {
    if (busy.current) return;
    const current = loadOutbox();
    if (!current.some((s) => !s.error && mine(s))) return;
    busy.current = true;
    try {
      let unauthorized = false;
      const left = await flushOutbox(current.filter(mine), async (s) => {
        try {
          await till(docPath("PosInvoice"), { method: "POST", body: s.body, query: { submit: true }, idempotencyKey: s.key });
        } catch (e) {
          if ((e as { status?: number })?.status === 401) unauthorized = true;
          throw e;
        }
      });
      setSignedOut(unauthorized);
      // Others' sales, and sales queued while this ran, stay queued.
      const others = current.filter((s) => !mine(s));
      const added = loadOutbox().filter((s) => !current.some((c) => c.key === s.key));
      update([...left, ...others, ...added]);
    } finally {
      busy.current = false;
    }
  }, [update, mine]);
  useEffect(() => {
    const tick = () => {
      if (navigator.onLine) void flush();
    };
    tick();
    const timer = setInterval(tick, 15_000);
    window.addEventListener("online", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", tick);
    };
  }, [flush]);
  // Leaving with sales not sent asks first; they stay on this device either way.
  useEffect(() => shell().leaveGuard(() => loadOutbox().length > 0), []);
  const add = (s: QueuedSale) => update([...loadOutbox(), s]);
  const retry = (key: string) => {
    update(loadOutbox().map((s) => (s.key === key ? { ...s, error: undefined } : s)));
    void flush();
  };
  const discard = (key: string) => update(loadOutbox().filter((s) => s.key !== key));
  return { queued, mine, signedOut, add, flush, retry, discard };
}

function Till({ profile, sessionId, modes, book }: { profile: Doc; sessionId: string; modes: Doc[]; book: PriceBook | null }) {
  const qc = useQueryClient();
  const [lines, setLines] = useState<CartLine[]>([]);
  const [customer, setCustomer] = useState<{ id: string | null; title?: string }>({ id: null });
  const [search, setSearch] = useState("");
  const [paying, setPaying] = useState(false);
  const [receipt, setReceipt] = useState<Doc | null>(null);
  const saleKey = useRef(newKey());
  const scan = useRef<HTMLInputElement>(null);
  const outbox = useOutbox();
  const groups = ((profile.item_groups as Doc[] | undefined) ?? []).map((g) => str(g.item_group)).filter(Boolean);
  const q = useDebounced(search.trim(), 200);
  const items = useQuery({
    queryKey: ["pos", "items", str(profile.id), q],
    queryFn: async ({ signal }) => {
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
        // Offline: the price book's items.
        if (!unreachable(e) || !book) throw e;
        return { rows: searchBook(book, q).map((i) => ({ id: i.id, item_code: i.code, item_name: i.name, barcode: i.barcode })) };
      }
    },
    staleTime: 60_000,
    retry: false,
  });
  const body = useMemo(
    () => (lines.length ? invoiceBody({ profile: str(profile.id), session: sessionId, customer: customer.id, lines, tenders: [] }) : null),
    [lines, customer.id, profile.id, sessionId],
  );
  const calc = useCalc(body, lines, book);
  const priced = (calc.doc?.items as Doc[] | undefined) ?? [];
  const due = num(calc.doc?.rounded_total ?? calc.doc?.grand_total);
  const ready = lines.length > 0 && !calc.pending && !calc.error && !!calc.doc;

  const add = (item: { id: string; name: string }, qty = 1) => setLines((l) => addItem(l, item, qty));

  // Enter in the search box scans: a pack barcode, else an item's own barcode or code.
  const onScan = async (e: FormEvent) => {
    e.preventDefault();
    const code = search.trim();
    if (!code) return;
    try {
      const packs = await list("ItemBarcode", { filters: JSON.stringify({ barcode: code }), fields: "id,item,qty", titles: true, limit: 1 });
      const pack = packs.rows[0];
      if (pack) {
        add({ id: str(pack.item), name: titleOf(pack, "item") }, num(pack.qty) || 1);
        setSearch("");
        return;
      }
      const found = await list("Item", { search: code, fields: "id,item_code,item_name,barcode", filters: JSON.stringify({ disabled: false }), limit: 10 });
      const exact = found.rows.filter((r) => str(r.barcode) === code || str(r.item_code).toLowerCase() === code.toLowerCase());
      const hit = exact.length === 1 ? exact[0] : found.rows.length === 1 ? found.rows[0] : undefined;
      if (hit) {
        add({ id: str(hit.id), name: str(hit.item_name) || str(hit.item_code) });
        setSearch("");
      } else if (!found.rows.length) {
        toast(`Nothing matches “${code}”`, "error");
      }
    } catch (err) {
      if (unreachable(err) && book) {
        const hit = scanBook(book, code);
        if (hit) {
          add({ id: hit.item.id, name: hit.item.name || hit.item.code }, hit.qty);
          setSearch("");
        } else toast(`Nothing on this device matches “${code}”`, "error");
        return;
      }
      toast(errorMessage(err), "error");
    }
  };

  const reset = () => {
    setLines([]);
    setCustomer({ id: null });
    setPaying(false);
    saleKey.current = newKey();
    scan.current?.focus();
  };

  const complete = async (tenders: Tender[]): Promise<string | null> => {
    const now = new Date();
    const local = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    // When it was sold, not when it reaches the server.
    const sale: Doc = { ...invoiceBody({ profile: str(profile.id), session: sessionId, customer: customer.id, lines, tenders }), posting_date: local(now), posting_time: now.toTimeString().slice(0, 8) };
    const key = saleKey.current;
    const keep = () => {
      outbox.add({ key, body: sale, at: now.toISOString(), by: myEmail(), total: String(due) });
      // A receipt now, marked as not yet sent; the server numbers the sale when it arrives.
      const named = ((profile.payments as Doc[] | undefined) ?? []).map((r) => [str(r.mode_of_payment), titleOf(r, "mode_of_payment")] as const);
      const payments = ((sale.payments as Doc[] | undefined) ?? []).map((p) => ({ ...p, _titles: { mode_of_payment: named.find(([id]) => id === p.mode_of_payment)?.[1] ?? "" } }));
      const change = String(Math.max(0, -balance(due, tenders.reduce((s, t) => s + num(t.amount), 0))));
      setReceipt({ ...(calc.doc ?? {}), ...sale, payments, number: "Not sent yet", rounded_total: String(due), change_amount: change, pending: true });
      reset();
      return null;
    };
    if (calc.offline) return keep();
    try {
      const done = await till<Doc>(docPath("PosInvoice"), { method: "POST", body: sale, query: { submit: true }, idempotencyKey: key });
      setReceipt(done);
      void qc.invalidateQueries({ queryKey: ["list", "PosInvoice"] });
      reset();
      return null;
    } catch (err) {
      if (!unreachable(err)) return errorMessage(err);
      return keep();
    }
  };

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
      <section className="grid content-start gap-3" aria-label="Items">
        <form onSubmit={onScan} className="flex gap-2">
          <div className="relative flex-1">
            <ScanBarcode className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              ref={scan}
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Scan a barcode or search items"
              aria-label="Scan a barcode or search items"
              className={cn("pl-8", TAP)}
            />
          </div>
          <Button type="submit" variant="outline" className={TAP}>
            Add
          </Button>
        </form>
        {outbox.queued.length > 0 && (
          <OutboxBar queued={outbox.queued} mine={outbox.mine} signedOut={outbox.signedOut} onSend={() => void outbox.flush()} onRetry={outbox.retry} onDiscard={outbox.discard} />
        )}
        {items.error ? (
          <ErrorState error={items.error} onRetry={() => void items.refetch()} />
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            {items.isLoading && Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-20" />)}
            {(items.data?.rows ?? []).map((r) => (
              <li key={str(r.id)}>
                <button
                  type="button"
                  onClick={() => add({ id: str(r.id), name: str(r.item_name) || str(r.item_code) })}
                  className="grid h-full min-h-20 w-full content-between gap-1 rounded-lg border bg-card p-3 text-left text-sm hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <span className="line-clamp-2 font-medium">{str(r.item_name) || str(r.item_code)}</span>
                  <span className="text-xs text-muted-foreground">{str(r.item_code)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {items.data && !items.data.rows.length && <p className="text-sm text-muted-foreground">No items match.</p>}
      </section>

      <section className="grid content-start gap-3 rounded-lg border bg-card p-3 lg:sticky lg:top-4" aria-label="Sale">
        <LinkInput
          to="Customer"
          value={customer.id}
          title={customer.title}
          onChange={(id, title) => setCustomer({ id, title })}
          label="Customer"
          placeholder={titleOf(profile, "customer") || "Walk-in customer"}
        />
        {lines.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Scan or tap items to start a sale.</p>
        ) : (
          <ul className="grid gap-1.5">
            {lines.map((l, i) => (
              <li key={l.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md border p-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{l.item_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {priced[i] ? `${money(priced[i].rate)} each · ${money(priced[i].amount)}` : calc.pending ? "Pricing…" : ""}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="icon-sm" className={TAP} aria-label={`One less ${l.item_name}`} onClick={() => setLines((x) => setQty(x, l.key, l.qty - 1))}>
                    {l.qty <= 1 ? <Trash2 /> : <Minus />}
                  </Button>
                  <QtyInput label={l.item_name} qty={l.qty} onChange={(v) => setLines((x) => setQty(x, l.key, v))} />
                  <Button variant="outline" size="icon-sm" className={TAP} aria-label={`One more ${l.item_name}`} onClick={() => setLines((x) => setQty(x, l.key, l.qty + 1))}>
                    <Plus />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {calc.error && (
          <p role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
            {calc.error}
          </p>
        )}
        {calc.doc && lines.length > 0 && (
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Subtotal</dt>
            <dd className="text-right tabular-nums">{money(calc.doc.total)}</dd>
            {num(calc.doc.discount_amount) !== 0 && (
              <>
                <dt className="text-muted-foreground">Discount</dt>
                <dd className="text-right tabular-nums">−{money(calc.doc.discount_amount)}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Taxes</dt>
            <dd className="text-right tabular-nums">{money(calc.doc.total_taxes)}</dd>
            <dt className="text-base font-semibold">Total</dt>
            <dd className="text-right text-base font-semibold tabular-nums">{money(due)}</dd>
            {calc.offline && book && (
              <dd className="col-span-2 text-xs text-muted-foreground">Priced on this device (prices of {new Date(book.built_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}); checked again when the sale is sent.</dd>
            )}
          </dl>
        )}
        <div className="grid grid-cols-[auto_1fr] gap-2">
          <Button variant="outline" className={TAP} disabled={!lines.length} onClick={reset}>
            Clear
          </Button>
          <Button className={cn("text-base", TAP)} disabled={!ready} onClick={() => setPaying(true)}>
            {calc.pending ? "Pricing…" : ready ? `Pay ${money(due)}` : "Pay"}
          </Button>
        </div>
      </section>
      {lines.length > 0 && (
        // Phones: the sale panel is below the items, so the total and Pay stay in reach.
        <div className="sticky bottom-0 z-10 -mx-3 flex items-center gap-3 border-t bg-background/95 p-3 backdrop-blur lg:hidden">
          <span className="flex-1 text-sm">
            {lines.length} {lines.length === 1 ? "line" : "lines"}
            {ready && <span className="block text-base font-semibold tabular-nums">{money(due)}</span>}
          </span>
          <Button className={cn("text-base", TAP)} disabled={!ready} onClick={() => setPaying(true)}>
            {calc.pending ? "Pricing…" : "Pay"}
          </Button>
        </div>
      )}
      {paying && <PayDialog profile={profile} modes={modes} due={due} onClose={() => setPaying(false)} onComplete={complete} />}
      {receipt && <ReceiptDialog profile={profile} sale={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}

/** A quantity box that only applies positive numbers, so clearing it to retype never drops the line. */
function QtyInput({ label, qty, onChange }: { label: string; qty: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(qty));
  useEffect(() => setText(String(qty)), [qty]);
  return (
    <Input
      inputMode="decimal"
      aria-label={`Quantity of ${label}`}
      className="h-8 w-14 text-center"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const v = Number(e.target.value);
        if (e.target.value.trim() && Number.isFinite(v) && v > 0) onChange(v);
      }}
      onBlur={() => setText(String(qty))}
    />
  );
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
  const refused = queued.filter((s) => s.error && mine(s));
  const others = queued.filter((s) => !mine(s));
  const own = queued.length - others.length;
  return (
    <div role="status" className="grid gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-50">
      {own > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <WifiOff className="size-4" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            {own === 1 ? "1 sale is" : `${own} sales are`} kept on this device until {signedOut ? "you sign in again" : "they can be sent"}.
          </span>
          {signedOut ? (
            <Button size="sm" variant="outline" onClick={() => shell().session.reauthenticate()}>
              Sign in to send
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={onSend}>
              Send now
            </Button>
          )}
        </div>
      )}
      {others.length > 0 && (
        <p className="border-t border-amber-300/60 pt-2 first:border-0 first:pt-0">
          {others.length === 1 ? "1 sale" : `${others.length} sales`} by {[...new Set(others.map((s) => s.by))].join(", ")} will be sent when they sign in on this device.
        </p>
      )}
      {refused.map((s) => (
        <div key={s.key} className="flex flex-wrap items-center gap-2 border-t border-amber-300/60 pt-2">
          <span className="min-w-0 flex-1">
            Sale of {new Date(s.at).toLocaleTimeString()}
            {s.total ? ` (${money(s.total)})` : ""} was refused: {s.error}
          </span>
          <Button size="sm" variant="outline" onClick={() => onRetry(s.key)}>
            Retry
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onDiscard(s.key)}>
            Discard
          </Button>
        </div>
      ))}
    </div>
  );
}

function PayDialog({ profile, modes, due, onClose, onComplete }: { profile: Doc; modes: Doc[]; due: number; onClose: () => void; onComplete: (t: Tender[]) => Promise<string | null> }) {
  const rows = (profile.payments as Doc[] | undefined) ?? [];
  const typeOf = (id: string) => str(modes.find((m) => m.id === id)?.mode_type);
  const [tenders, setTenders] = useState<Tender[]>(() =>
    rows.map((r, i) => ({ mode_of_payment: str(r.mode_of_payment), amount: (r.is_default || (i === 0 && !rows.some((x) => x.is_default))) ? String(due) : "" })),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tendered = tenders.reduce((s, t) => s + num(t.amount), 0);
  const left = balance(due, tendered);
  const cash = tenders.findIndex((t) => typeOf(t.mode_of_payment) === "Cash");
  const set = (i: number, amount: string) => setTenders((ts) => ts.map((t, j) => (j === i ? { ...t, amount } : t)));
  const pay = async () => {
    setBusy(true);
    setError(await onComplete(tenders));
    setBusy(false);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Take payment</DialogTitle>
          <DialogDescription>Total due {money(due)}. Split it across ways of paying if the customer wants.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {tenders.map((t, i) => {
            const id = `tender-${t.mode_of_payment}`;
            return (
              <div key={id} className="grid gap-1.5">
                <Label htmlFor={id}>{titleOf(rows[i], "mode_of_payment")}</Label>
                <Input id={id} inputMode="decimal" placeholder="0.00" value={t.amount} onChange={(e) => set(i, e.target.value)} />
              </div>
            );
          })}
          {cash >= 0 && (
            <div className="flex flex-wrap gap-2" aria-label="Cash handed over">
              {quickCash(due).map((v) => (
                <Button key={v} type="button" variant="outline" size="sm" className={TAP} onClick={() => set(cash, String(v))}>
                  {money(v)}
                </Button>
              ))}
            </div>
          )}
          <p className={cn("text-base font-semibold tabular-nums", left > 0 && "text-destructive")} aria-live="polite">
            {left > 0 ? `Still due ${money(left)}` : left < 0 ? `Change ${money(-left)}` : "Paid exactly"}
          </p>
          {error && (
            <p role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Back
          </Button>
          <Button onClick={() => void pay()} disabled={busy || left > 0} className={TAP}>
            {busy ? "Completing…" : "Complete sale"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function printReceipt(html: string) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0";
  document.body.append(frame);
  const w = frame.contentWindow;
  if (!w) return frame.remove();
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
  setTimeout(() => frame.remove(), 60_000);
}

function ReceiptDialog({ profile, sale, onClose }: { profile: Doc; sale: Doc; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{sale.pending ? "Sale kept on this device" : "Sale complete"}</DialogTitle>
          <DialogDescription>
            {sale.pending ? "It is sent and numbered when the connection is back." : str(sale.number)} · {money(sale.rounded_total ?? sale.grand_total)}
            {num(sale.change_amount) > 0 && ` · change ${money(sale.change_amount)}`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => printReceipt(receiptHtml(profile, sale))}>
            <Printer /> Print receipt
          </Button>
          <Button autoFocus onClick={onClose}>
            Next sale
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
