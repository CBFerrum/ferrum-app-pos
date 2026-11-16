// The Point of Sale's own interface (Ferrum docs/plan/apps-ui.md §13) at /pos/: the till, full
// screen and working offline (its own worker, public/sw.js, keeps the page and its files; the
// till keeps the price book and the sales it could not send), the end of a shift at /shift, and the
// register's records — profiles, sessions, sales, closings, loyalty — as lists and forms in the
// records frame. What needs the server (returns, opening and closing a shift) loads when asked for.

import { useEffect, type ReactNode } from "react";
import { Link, Outlet, useRouteError } from "react-router";
import { routeBase, shell, t } from "@ferrum/client";
import { StatePanel } from "@ferrum/kit";
import { Problem } from "./ui";
import { mountApp, RequireAuth, setFrameMode } from "@ferrum/records/frame";
import { keepToTheLease } from "./lib/offline";
import { warmPricing } from "./lib/pricing";
import { RegisterPage } from "./Register";
import "./styles.css";

function RouteError() {
  return <Problem error={useRouteError()} onRetry={() => window.location.reload()} />;
}

function NotFound() {
  return (
    <StatePanel kind="empty" title={t("Page not found")} action={<Link to="/">{t("Go to the till")}</Link>} />
  );
}

/** Every page tells the shell it started. */
function Started() {
  useEffect(() => shell().ready(), []);
  return null;
}

/** A full-screen page of the till: the whole page under the bar. */
function Page({ children }: { children: ReactNode }) {
  return (
    <main id="main" tabIndex={-1} className="min-h-[calc(100dvh-var(--ferrum-bar-height,48px))] bg-background">
      {children}
    </main>
  );
}

function TillPage() {
  return (
    <Page>
      <RegisterPage />
    </Page>
  );
}

// The page works offline only under its own worker; one that cannot register (a private window,
// an old browser) leaves the till working online.
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register(`${routeBase("pos")}sw.js`, { scope: routeBase("pos") }).catch(() => {});
  // The pricing engine's two files (ERP's pricing crate in WebAssembly), through the worker, so they are on this device before they are needed
  // offline: only fetched here, never run until a sale is priced offline.
  const warm = () => void warmPricing();
  navigator.serviceWorker.addEventListener("controllerchange", warm);
  if (navigator.serviceWorker.controller) warm();
}

setFrameMode("app", ["pos"]);

keepToTheLease();

mountApp({
  route: "pos",
  catalogs: { ar: () => import("./locales/ar.json"), hi: () => import("./locales/hi.json") },
  routes: [
    {
      path: "/",
      element: (
        <>
          <Started />
          <Outlet />
        </>
      ),
      errorElement: <RouteError />,
      children: [
        { index: true, element: <TillPage /> },
        // Counting the drawer and closing the shift: online, so it loads when asked for.
        { path: "shift", lazy: () => import("./Shift").then((m) => ({ Component: () => <Page><m.default /></Page> })) },
        // The reviewer's list of sales made offline that the register priced to another total: online, a manager's.
        { path: "differences", lazy: () => import("./Differences").then((m) => ({ Component: () => <Page><m.default /></Page> })) },
        {
          element: <RequireAuth />,
          // The register's records load when opened (online pages; the till above works
          // offline), keeping the first script within its budget (apps-ui.md §12.9).
          children: [
            { path: "e/:entity", lazy: () => import("@ferrum/records").then((m) => ({ Component: m.ListView })) },
            { path: "e/:entity/:id", lazy: () => import("@ferrum/records").then((m) => ({ Component: m.FormView })) },
            { path: "r/:name", lazy: () => import("@ferrum/records").then((m) => ({ Component: m.ReportView })) },
          ],
        },
        { path: "*", element: <NotFound /> },
      ],
    },
  ],
});
