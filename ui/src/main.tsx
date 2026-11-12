// The Point of Sale's own interface (Ferrum docs/plan/apps-ui.md §13) at /pos/: the till, full
// screen and working offline (its own worker, public/sw.js, keeps the page and its files; the
// till keeps the price book and the sales it could not send), the end of a shift at /shift, and the
// register's records — profiles, sessions, sales, closings, loyalty — as lists and forms in the
// records frame. What needs the server (returns, opening and closing a shift) loads when asked for.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, Outlet, RouterProvider, useRouteError } from "react-router";
import { engineUrl } from "@ferrum/calc";
import { addCatalogs, routeBase, shell, t, wordsReady } from "@ferrum/client";
import { ConfirmHost, StatePanel, Toaster } from "@ferrum/kit";
import { Problem } from "./ui";
import { RequireAuth, setFrameMode } from "@ferrum/records/frame";
import { keepToTheLease } from "./lib/offline";
import { RegisterPage } from "./Register";
import "./styles.css";

// Its own words in the page's language (src/locales), fetched as the page starts; it is drawn once they are in.
void addCatalogs({ ar: () => import("./locales/ar.json"), hi: () => import("./locales/hi.json") });

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 } },
});

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
  // The pricing engine, through the worker, so it is on this device before it is needed offline.
  const warm = () => void fetch(engineUrl).catch(() => {});
  navigator.serviceWorker.addEventListener("controllerchange", warm);
  if (navigator.serviceWorker.controller) warm();
}

setFrameMode("app", ["pos"]);

const router = createBrowserRouter(
  [
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
            { path: "apps/:app/settings", lazy: () => import("@ferrum/records/frame").then((m) => ({ Component: m.AppSettingsPage })) },
            { path: "x/:app/:page", lazy: () => import("@ferrum/records/frame").then((m) => ({ Component: m.ScreenPage })) },
          ],
        },
        { path: "*", element: <NotFound /> },
      ],
    },
  ],
  { basename: routeBase("pos") },
);

keepToTheLease();

// Drawn once the page's words are in (its language's catalogs, fetched as the page starts).
void wordsReady().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <Toaster />
        <ConfirmHost />
      </QueryClientProvider>
    </StrictMode>,
  ),
);
