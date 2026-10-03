import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import { I18nProvider, useT } from "./lib/i18n";
import { Login } from "./pages/Login";
import { Landing } from "./pages/Landing";
import { DesktopBootstrap, EntitlementGate } from "./components/Desktop";
import { useGlobalModalA11y } from "./lib/a11y";
import type { ReactNode } from "react";

// App-shell routes are split out of the entry chunk — the public landing and
// login pages hydrate fast; the workspace loads on first navigation after
// auth (warmed by the prefetch in Login).
const Home = lazy(() => import("./pages/Home").then((m) => ({ default: m.Home })));
const Drive = lazy(() => import("./pages/Drive").then((m) => ({ default: m.Drive })));
const Editor = lazy(() => import("./pages/Editor").then((m) => ({ default: m.Editor })));
const SharedLink = lazy(() => import("./pages/SharedLink").then((m) => ({ default: m.SharedLink })));
const Admin = lazy(() => import("./pages/Admin").then((m) => ({ default: m.Admin })));
const Shell = lazy(() => import("./components/Shell").then((m) => ({ default: m.Shell })));

const RouteFallback = () => (
  <div className="auth-wrap"><div className="empty">Loading…</div></div>
);

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const t = useT();
  if (loading) return <div className="auth-wrap"><div className="empty">{t("app.loading")}</div></div>;
  if (!user) return <Navigate to="/login" replace />;
  return <EntitlementGate>{children}</EntitlementGate>;
}

/** Keeps document.title in sync with the route (editors overwrite it with
 *  the file name once loaded). */
function TitleSync() {
  const { pathname } = useLocation();
  useEffect(() => {
    const name = pathname === "/login" ? "Sign in"
      : pathname === "/register" ? "Create account"
      : pathname === "/" ? "Make room for your best work"   // landing page headline
      : pathname === "/home" ? "Home"
      : pathname.startsWith("/drive") ? "Drive"
      : pathname.startsWith("/admin") ? "Admin"
      : pathname.startsWith("/shared") ? "Shared file"
      : pathname.startsWith("/edit") ? null   // editor sets its own title
      : null;
    if (name) document.title = `${name} · Kreatix Suites`;
  }, [pathname]);
  return null;
}

/** Public landing for guests, workspace home for signed-in users. */
function LandingOrHome() {
  const { user, loading } = useAuth();
  const t = useT();
  if (loading) return <div className="auth-wrap"><div className="empty">{t("app.loading")}</div></div>;
  return user ? <Navigate to="/home" replace /> : <Landing />;
}

export default function App() {
  useGlobalModalA11y(); // retrofit focus-trap/Escape/aria onto every dlg/overlay
  return (
    <I18nProvider>
    <AuthProvider>
      <BrowserRouter>
        <TitleSync />
        <DesktopBootstrap />
        <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<LandingOrHome />} />
          <Route path="/login" element={<Login mode="login" />} />
          <Route path="/register" element={<Login mode="register" />} />
          <Route path="/shared/:token" element={<SharedLink />} />
          <Route path="/edit/:id" element={<Protected><Editor /></Protected>} />
          <Route element={<Protected><Shell /></Protected>}>
            <Route path="/home" element={<Home />} />
            <Route path="/drive" element={<Drive />} />
            <Route path="/drive/:view" element={<Drive />} />
            <Route path="/drive/folder/:folderId" element={<Drive />} />
            <Route path="/admin" element={<Admin />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
    </I18nProvider>
  );
}
