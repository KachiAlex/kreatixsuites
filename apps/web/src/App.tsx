import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import { Shell } from "./components/Shell";
import { Login } from "./pages/Login";
import { Home } from "./pages/Home";
import { Drive } from "./pages/Drive";
import { Editor } from "./pages/Editor";
import { SharedLink } from "./pages/SharedLink";
import type { ReactNode } from "react";

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="auth-wrap"><div className="empty">Loading workspace…</div></div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login mode="login" />} />
          <Route path="/register" element={<Login mode="register" />} />
          <Route path="/shared/:token" element={<SharedLink />} />
          <Route path="/edit/:id" element={<Protected><Editor /></Protected>} />
          <Route element={<Protected><Shell /></Protected>}>
            <Route path="/" element={<Home />} />
            <Route path="/drive" element={<Drive />} />
            <Route path="/drive/:view" element={<Drive />} />
            <Route path="/drive/folder/:folderId" element={<Drive />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
