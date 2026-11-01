// The register: pick a register, open a shift with its float, and sell (Till.tsx). What the page
// needs, it asks the server for: the register's rules, the cashier's open session and the ways of
// paying; when the server cannot be reached it starts from what this device last knew, so the till
// opens and sells offline (lib/offline.ts). Each sale is created and submitted in one request with
// an idempotency key; one that cannot be sent waits in an outbox (lib/pos.ts, hooks.ts) with the
// person who made it, and goes when the connection, or their session, is back.

import { useQuery } from "@tanstack/react-query";
import { CloudOff, Store } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { docPath } from "@ferrum/client";
import { Badge, Button, EmptyState, ErrorState, PageLoading } from "@ferrum/kit";
import type { Doc } from "@ferrum/records";
import { Currency, myEmail, remember, remembered, str, titleOf } from "./fmt";
import { useManager, usePriceBook } from "./hooks";
import { knownRegisters, recallTill, rememberTill, till, unreachable, type TillMemory } from "./lib/offline";
import { Till } from "./Till";

// Opening a shift needs the server and is done once a day: it loads when a register has no session.
const Open = lazy(() => import("./Open"));

interface ListResponse {
  rows: Doc[];
}

const list = (entity: string, query: Record<string, string | number | boolean | undefined>, signal?: AbortSignal) => till<ListResponse>(docPath(entity), { query, signal });

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
  // A shop with one register never picks it; the shift page still has to know which it is.
  useEffect(() => {
    if (profileId) remember(profileId);
  }, [profileId]);

  if (profiles.isLoading) return <PageLoading label="Loading registers…" />;
  if (profiles.error && !offline) return <ErrorState error={profiles.error} onRetry={() => void profiles.refetch()} />;
  if (!rows.length) {
    return offline ? (
      <EmptyState title="No connection" icon="alert">
        This device has not opened a register yet: connect once to set it up for working offline.
      </EmptyState>
    ) : (
      <EmptyState title="No registers yet" icon="store">
        <Link to="/e/PosProfile/new">Set up a POS profile</Link> for this shop first.
      </EmptyState>
    );
  }
  if (!profileId) {
    return (
      <div className="pos-picker">
        <h1>Choose a register</h1>
        {rows.map((r) => (
          <Button
            key={str(r.id)}
            className="pos-btn pos-pick"
            icon="store"
            onClick={() => {
              remember(str(r.id));
              setChosen(str(r.id));
            }}
          >
            {str(r.profile_name)}
          </Button>
        ))}
      </div>
    );
  }
  return <Register key={profileId} profileId={profileId} onSwitch={rows.length > 1 ? () => setChosen(null) : undefined} />;
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
    queryFn: ({ signal }) => list("PosOpeningEntry", { filters: JSON.stringify({ pos_profile: profileId, status: "Open", user: email }), fields: "id,number,period_start", limit: 1 }, signal),
    enabled: !!email,
    retry: false,
  });
  const modes = useQuery({
    queryKey: ["pos", "modes"],
    queryFn: ({ signal }) => list("ModeOfPayment", { fields: "id,mode_name,mode_type", limit: 200 }, signal),
    staleTime: 300_000,
    retry: false,
  });
  const manager = useManager(memory?.manager);
  // What the server says, else (offline) what this device last knew.
  const offline = [profile.error, session.error].some((e) => e && unreachable(e));
  const profileDoc = profile.data ?? (offline ? memory?.profile : undefined);
  const open = session.data ? (session.data.rows[0] ? { id: str(session.data.rows[0].id), number: str(session.data.rows[0].number) } : null) : offline ? (memory?.session ?? null) : null;
  const modeRows = modes.data?.rows ?? memory?.modes ?? [];
  useEffect(() => {
    if (profile.data && session.data) rememberTill({ email, profile: profile.data, session: open, modes: modeRows, manager } satisfies TillMemory);
  }, [profile.data, session.data, modes.data, manager]); // eslint-disable-line react-hooks/exhaustive-deps
  const book = usePriceBook(profileId, open?.id ?? null);

  if ((profile.isLoading || session.isLoading) && !memory) return <PageLoading label="Opening the register…" />;
  if (!email) return <ErrorState error={new Error("Sign in to use the register")} />;
  const error = offline ? null : (profile.error ?? session.error);
  if (error || !profileDoc) {
    return <ErrorState error={error ?? new Error("This register is not on this device yet: connect once to set it up.")} onRetry={() => void Promise.all([profile.refetch(), session.refetch()])} />;
  }
  if (open) return <Till profile={profileDoc} session={open} modes={modeRows} book={book} manager={manager} offline={offline} onSwitch={onSwitch} />;
  return (
    <div className="pos-away">
      <div className="pos-head">
        <Store className="size-5 text-muted-foreground" aria-hidden="true" />
        <h1>{str(profileDoc.profile_name)}</h1>
        {offline && (
          <Badge tone="amber">
            <CloudOff className="size-3.5" aria-hidden="true" /> Offline
          </Badge>
        )}
        <span className="spacer" />
        {onSwitch && <Button onClick={onSwitch}>Switch register</Button>}
      </div>
      {offline ? (
        <EmptyState title="No open session on this device" icon="alert">
          Open the register while connected; it then keeps selling offline.
        </EmptyState>
      ) : (
        <Currency.Provider value={{ precision: book?.engine.precision ?? 2, code: book?.currency || titleOf(profileDoc, "currency") }}>
          {modes.isLoading && !modeRows.length ? (
            <PageLoading label="Getting the register ready…" />
          ) : (
            <Suspense fallback={<PageLoading label="Getting the register ready…" />}>
              <Open profile={profileDoc} modes={modeRows} onOpened={() => void session.refetch()} />
            </Suspense>
          )}
        </Currency.Provider>
      )}
    </div>
  );
}
