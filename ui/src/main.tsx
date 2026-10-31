// The Point of Sale's own interface (Ferrum docs/plan/apps-ui.md §13) at /pos/: the till, full
// screen and working offline (its own worker, public/sw.js, keeps the page and its files; the
// till keeps the price book and the sales it could not send), and the register's records —
// profiles, sessions, sales, closings, loyalty — as lists and forms in the records frame.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, Outlet, RouterProvider, useRouteError } from "react-router";
import { engineUrl } from "@ferrum/calc";
import { routeBase, shell } from "@ferrum/client";
import { ConfirmHost, EmptyState, ErrorState, Toaster } from "@ferrum/kit";
import { FormView, ListView, ReportView } from "@ferrum/records";
import { AppSettingsPage, RequireAuth, ScreenPage, setFrameMode } from "@ferrum/records/frame";
import { RegisterPage } from "./Register";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 } },
});

function RouteError() {
  return <ErrorState error={useRouteError()} onRetry={() => window.location.reload()} />;
}

function NotFound() {
  return (
    <EmptyState title="Page not found">
      <Link to="/">Go to the till</Link>
    </EmptyState>
  );
}

/** Every page tells the shell it started. */
function Started() {
  useEffect(() => shell().ready(), []);
  return null;
}

/** The till: the whole page under the bar. */
function TillPage() {
  return (
    <main id="main" tabIndex={-1} className="min-h-[calc(100dvh-var(--ferrum-bar-height,48px))] bg-background">
      <RegisterPage />
    </main>
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
        {
          element: <RequireAuth />,
          children: [
            { path: "e/:entity", element: <ListView /> },
            { path: "e/:entity/:id", element: <FormView /> },
            { path: "r/:name", element: <ReportView /> },
            { path: "apps/:app/settings", element: <AppSettingsPage /> },
            { path: "x/:app/:page", element: <ScreenPage /> },
          ],
        },
        { path: "*", element: <NotFound /> },
      ],
    },
  ],
  { basename: routeBase("pos") },
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
      <ConfirmHost />
    </QueryClientProvider>
  </StrictMode>,
);
