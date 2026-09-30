import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import { Shell } from "./components/Shell";
import { Login } from "./pages/Login";
import { Home } from "./pages/Home";
import { Landing } from "./pages/Landing";
import { Drive } from "./pages/Drive";
import { Editor } from "./pages/Editor";
import { SharedLink } from "./pages/SharedLink";
import { Admin } from "./pages/Admin";
import { DesktopBootstrap, EntitlementGate } from "./components/Desktop";
import type { ReactNode } from "react";

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="auth-wrap"><div className="empty">Loading workspace…</div></div>;
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
      : pathname === "/" ? "Office suite"   // landing page: "Office suite · Kreatix Suites"
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
  if (loading) return <div className="auth-wrap"><div className="empty">Loading workspace…</div></div>;
  return user ? <Navigate to="/home" replace /> : <Landing />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <TitleSync />
        <DesktopBootstrap />
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
      </BrowserRouter>
    </AuthProvider>
  );
}
