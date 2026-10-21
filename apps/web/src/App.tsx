import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import { I18nProvider, useT } from "./lib/i18n";
import { Login } from "./pages/Login";
import { ResetPassword, VerifyEmail } from "./pages/AccountRecovery";
import { Landing } from "./pages/Landing";
import { DesktopBootstrap, EntitlementGate } from "./components/Desktop";
import MfaEnrollScreen from "./components/MfaEnrollScreen";
import { useGlobalModalA11y } from "./lib/a11y";
import { isNativeMobile } from "./lib/platform";
import type { ReactNode } from "react";

// App-shell routes are split out of the entry chunk — the public landing and
// login pages hydrate fast; the workspace loads on first navigation after
// auth (warmed by the prefetch in Login).
const Home = lazy(() => import("./pages/Home").then((m) => ({ default: m.Home })));
const Drive = lazy(() => import("./pages/Drive").then((m) => ({ default: m.Drive })));
const Editor = lazy(() => import("./pages/Editor").then((m) => ({ default: m.Editor })));
const SharedLink = lazy(() => import("./pages/SharedLink").then((m) => ({ default: m.SharedLink })));
const Admin = lazy(() => import("./pages/Admin").then((m) => ({ default: m.Admin })));
const PdfTools = lazy(() => import("./pages/PdfTools").then((m) => ({ default: m.PdfTools })));
const Sites = lazy(() => import("./pages/Sites").then((m) => ({ default: m.Sites })));
const SitePage = lazy(() => import("./pages/Site").then((m) => ({ default: m.SitePage })));
const LibraryPage = lazy(() => import("./pages/Library").then((m) => ({ default: m.LibraryPage })));
const Download = lazy(() => import("./pages/Download").then((m) => ({ default: m.Download })));
const Mail = lazy(() => import("./pages/Mail").then((m) => ({ default: m.Mail })));
const Meet = lazy(() => import("./pages/Meet").then((m) => ({ default: m.Meet })));
const Chat = lazy(() => import("./pages/Chat").then((m) => ({ default: m.Chat })));
const Calendar = lazy(() => import("./pages/Calendar").then((m) => ({ default: m.Calendar })));
const Tasks = lazy(() => import("./pages/Tasks").then((m) => ({ default: m.Tasks })));
const Forms = lazy(() => import("./pages/Forms").then((m) => ({ default: m.Forms })));
const FormFill = lazy(() => import("./pages/FormFill").then((m) => ({ default: m.FormFill })));
const Notes = lazy(() => import("./pages/Notes").then((m) => ({ default: m.Notes })));
const Shell = lazy(() => import("./components/Shell").then((m) => ({ default: m.Shell })));
const Account = lazy(() => import("./pages/Account").then((m) => ({ default: m.Account })));

const RouteFallback = () => (
  <div className="auth-wrap"><div className="empty">Loading…</div></div>
);

function Protected({ children }: { children: ReactNode }) {
  const { user, loading, mfaSetupRequired } = useAuth();
  const { pathname } = useLocation();
  const t = useT();
  if (loading) return <div className="auth-wrap"><div className="empty">{t("app.loading")}</div></div>;
  if (!user) return <Navigate to="/login" replace />;
  // org MFA mandate — the session is already API-gated to setup endpoints;
  // render the enroll wall until /me reports the secret enrolled
  if (mfaSetupRequired) return <MfaEnrollScreen />;
  // superadmin is a platform operator, not a workspace user — confine the
  // session to the portal; the API enforces the same boundary with 403s.
  if (user.isSuper && pathname !== "/admin") return <Navigate to="/admin" replace />;
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
      : pathname === "/download" ? "Download"
      : pathname === "/pdf-tools" ? "PDF tools"
      : pathname.startsWith("/sites") ? "Sites"
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

/** Public landing for guests, workspace home for signed-in users. The
 *  native app skips marketing pages — splash → straight to sign-in. */
function LandingOrHome() {
  const { user, loading } = useAuth();
  const t = useT();
  if (loading) return <div className="auth-wrap"><div className="empty">{t("app.loading")}</div></div>;
  if (isNativeMobile) return user ? <Navigate to="/home" replace /> : <Navigate to="/login" replace />;
  return user ? <Navigate to="/home" replace /> : <Landing />;
}

/** Cold-start splash for the native app — the kreatixtech.com animation:
 *  logo spins/scales in, tagline rises, orange progress bar, screen fades.
 *  ~2.9s, then the app underneath (login for guests) is revealed. */
function Splash() {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGone(true), 2900);
    return () => clearTimeout(t);
  }, []);
  if (gone) return null;
  return (
    <div className="kx-splash" aria-hidden="true">
      <img className="kx-splash-logo" src="/brand/kreatix-suites-dark.png" alt="" />
      <div className="kx-splash-tag">Make room for your best work</div>
      <div className="kx-splash-track"><span /></div>
    </div>
  );
}

export default function App() {
  useGlobalModalA11y(); // retrofit focus-trap/Escape/aria onto every dlg/overlay
  return (
    <I18nProvider>
    <AuthProvider>
      <BrowserRouter>
        {isNativeMobile && <Splash />}
        <TitleSync />
        <DesktopBootstrap />
        <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<LandingOrHome />} />
          <Route path="/login" element={<Login mode="login" />} />
          <Route path="/register" element={<Login mode="register" />} />
          <Route path="/forgot" element={<Login mode="forgot" />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route path="/download" element={<Download />} />
          <Route path="/shared/:token" element={<SharedLink />} />
          <Route path="/f/:token" element={<FormFill />} />
          <Route path="/edit/:id" element={<Protected><Editor /></Protected>} />
          <Route element={<Protected><Shell /></Protected>}>
            <Route path="/home" element={<Home />} />
            <Route path="/drive" element={<Drive />} />
            <Route path="/drive/:view" element={<Drive />} />
            <Route path="/drive/folder/:folderId" element={<Drive />} />
            <Route path="/pdf-tools" element={<PdfTools />} />
            <Route path="/mail" element={<Mail />} />
            <Route path="/meet" element={<Meet />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/forms" element={<Forms />} />
            <Route path="/notes" element={<Notes />} />
            <Route path="/sites" element={<Sites />} />
            <Route path="/sites/:siteId" element={<SitePage />} />
            <Route path="/sites/:siteId/library/:libId" element={<LibraryPage />} />
            <Route path="/sites/:siteId/library/:libId/folder/:folderId" element={<LibraryPage />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/account" element={<Account />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
    </I18nProvider>
  );
}
