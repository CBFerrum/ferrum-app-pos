// What the till keeps in step with: the register's price book, live totals for the cart, the outbox
// of sales not yet sent, and whether the person is a POS manager.

import { useCallback, useEffect, useRef, useState } from "react";
import { docPath, shell, t } from "@ferrum/client";
import { useDebounced } from "@ferrum/kit";
import type { Doc, Me } from "@ferrum/records";
import { errorMessage } from "@ferrum/client";
import { myEmail } from "./fmt";
import { downloadBook, loadBook, priceOffline, saveBook, serverDown, till, unreachable, type PriceBook } from "./lib/offline";
import { carriesCard, flushOutbox, loadOutbox, saveOutbox, type CartLine, type QueuedSale } from "./lib/pos";

/** How old a price book may get before the till fetches it again (while online). */
const BOOK_AGE_MS = 30 * 60_000;

/** The register's price book: from this device at once, then fetched again while online when it
 *  is older than half an hour or the session changed. */
export function usePriceBook(profileId: string, session: string | null) {
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

/** Whether the person is a POS manager (or an administrator), who work without the cashier's
 *  limits. Asked of the server; what the device last knew answers offline. */
export function useManager(remembered: boolean | undefined) {
  const [manager, setManager] = useState<boolean | undefined>(remembered);
  useEffect(() => {
    let live = true;
    till<Me>("/api/auth/me")
      .then((me) => live && setManager(me.user.is_admin || me.user.roles.includes("POS Manager")))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return manager ?? false;
}

export interface Calc {
  doc: Doc | null;
  error?: string;
  pending: boolean;
  /** Priced on this device from the price book. */
  offline?: boolean;
}

/** Live totals for the cart: from the server, else (unreachable, or lately so) from the price
 *  book with the server's own engine; the newest request wins. The body is compared as text, so
 *  what does not change the price (a note on a line) never asks again; and totals are pending from
 *  the moment the cart changes, not only once the request leaves, so Pay never shows old ones. */
export function useCalc(body: Doc | null, lines: CartLine[], book: PriceBook | null): Calc {
  const [state, setState] = useState<Calc>({ doc: null, pending: false });
  const [back, setBack] = useState(0);
  const key = body ? JSON.stringify(body) : "";
  const settled = useDebounced(key, 150);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  // A connection that returns prices the cart on the server again.
  useEffect(() => {
    const again = () => setBack((n) => n + 1);
    window.addEventListener("online", again);
    return () => window.removeEventListener("online", again);
  }, []);
  useEffect(() => {
    if (!settled) {
      setState({ doc: null, pending: false });
      return;
    }
    const ctl = new AbortController();
    const onDevice = async () => {
      if (!book) return setState({ doc: null, pending: false, error: t("No connection, and no prices on this device yet.") });
      try {
        const doc = await priceOffline(book, linesRef.current);
        if (!ctl.signal.aborted) setState({ doc, pending: false, offline: true });
      } catch (err) {
        if (!ctl.signal.aborted) setState({ doc: null, pending: false, error: errorMessage(err) });
      }
    };
    setState((s) => ({ ...s, pending: true }));
    if (book && serverDown()) {
      void onDevice();
      return () => ctl.abort();
    }
    till<Doc>(docPath("PosInvoice", "_calc"), { method: "POST", body: JSON.parse(settled) as Doc, signal: ctl.signal })
      .then((doc) => setState({ doc, pending: false }))
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        if (!unreachable(e)) return setState((s) => ({ doc: s.doc, pending: false, error: errorMessage(e) }));
        void onDevice();
      });
    return () => ctl.abort();
  }, [settled, book, back]);
  return { ...state, pending: state.pending || key !== settled };
}

/** The outbox, kept in step with storage, sent whenever the connection is back. Only the sales of
 *  the person signed in go out (each is sent in its maker's name); a 401 stops sending until they
 *  sign in again. A sale the server refuses for being there already (an earlier try got through,
 *  its answer was lost) is looked up and, if it is in the books, let go. */
export function useOutbox() {
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
      const left = await flushOutbox(
        current.filter(mine),
        async (s) => {
          try {
            await till(docPath("PosInvoice"), { method: "POST", body: s.body, query: { submit: true }, idempotencyKey: s.key });
          } catch (e) {
            if ((e as { status?: number })?.status === 401) unauthorized = true;
            throw e;
          }
        },
        async (s) => {
          const id = typeof s.body.id === "string" ? s.body.id : null;
          return !!id && (await till<Doc>(docPath("PosInvoice", id))).docstatus === 1;
        },
      );
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
  /** Keeps a sale on this device; false when the device would not keep it (or when it holds a card's code or PIN, which are never kept). */
  const add = (s: QueuedSale) => {
    if (carriesCard(s.body)) return false;
    const next = [...loadOutbox(), s];
    if (!saveOutbox(next)) return false;
    setQueued(next);
    return true;
  };
  const retry = (key: string) => {
    update(loadOutbox().map((s) => (s.key === key ? { ...s, error: undefined } : s)));
    void flush();
  };
  const discard = (key: string) => update(loadOutbox().filter((s) => s.key !== key));
  return { queued, mine, signedOut, add, flush, retry, discard };
}
