import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { ScrollToTop } from "./components/scroll-to-top";
import { ScreenSkeleton } from "./components/ui";
import { useAuth } from "./lib/auth";
import { AdminAudit, AdminClose, AdminHome, AdminImport, AdminInterest, AdminLoans, AdminMember, AdminMembers, AdminPay, AdminPayments, AdminSettings } from "./pages/admin";
import { LoginPage } from "./pages/login";
import { SetupMainAdminPage } from "./pages/setup-main-admin";
import { MemberHome, MemberInterest, MemberLoan, MemberMonthReport, MemberMore, MemberPayments } from "./pages/member";
import { AdminReports, MemberReports } from "./pages/reports";
import {
  AdminMonthCollected,
  AdminMonthToCollect,
  AdminMonthlyCollection,
  MemberMonthCollected,
  MemberMonthToCollect,
  MemberMonthlyCollection,
} from "./pages/society-month-books";
import { PlatformHome } from "./pages/platform";

function homeFor(role: string) {
  if (role === "MAIN_ADMIN") return "/platform";
  if (role === "MEMBER") return "/me";
  return "/app";
}

function Gate({ children, role }: { children: ReactNode; role: "staff" | "member" | "platform" }) {
  const { session, loading } = useAuth();
  if (loading) return <ScreenSkeleton />;
  if (!session) return <Navigate to="/" replace />;
  const staff = session.user.role === "OWNER" || session.user.role === "ADMIN";
  if (role === "platform" && session.user.role !== "MAIN_ADMIN") return <Navigate to={homeFor(session.user.role)} replace />;
  if (role === "staff" && !staff) return <Navigate to={homeFor(session.user.role)} replace />;
  if (role === "member" && session.user.role !== "MEMBER") return <Navigate to={homeFor(session.user.role)} replace />;
  return children;
}

export function App() {
  const { session, loading } = useAuth();
  return (
    <>
      <ScrollToTop />
      <Routes>
      <Route path="/" element={loading ? <ScreenSkeleton /> : session ? <Navigate to={homeFor(session.user.role)} replace /> : <LoginPage />} />
      <Route path="/setup" element={<SetupMainAdminPage />} />
      <Route path="/platform" element={<Gate role="platform"><PlatformHome /></Gate>} />
      <Route path="/app" element={<Gate role="staff"><AdminHome /></Gate>} />
      <Route path="/app/members" element={<Gate role="staff"><AdminMembers /></Gate>} />
      <Route path="/app/members/:id" element={<Gate role="staff"><AdminMember /></Gate>} />
      <Route path="/app/payments" element={<Gate role="staff"><AdminPayments /></Gate>} />
      <Route path="/app/pay" element={<Gate role="staff"><AdminPay /></Gate>} />
      <Route path="/app/loans" element={<Gate role="staff"><AdminLoans /></Gate>} />
      <Route path="/app/interest" element={<Gate role="staff"><AdminInterest /></Gate>} />
      <Route path="/app/close" element={<Gate role="staff"><AdminClose /></Gate>} />
      <Route path="/app/more" element={<Navigate to="/app/reports" replace />} />
      <Route path="/app/notifications" element={<Navigate to="/app" replace />} />
      <Route path="/app/month-sheet" element={<Gate role="staff"><AdminMonthToCollect /></Gate>} />
      <Route path="/app/month-collected" element={<Gate role="staff"><AdminMonthCollected /></Gate>} />
      <Route path="/app/monthly-collection" element={<Gate role="staff"><AdminMonthlyCollection /></Gate>} />
      <Route path="/app/reports" element={<Gate role="staff"><AdminReports /></Gate>} />
      <Route path="/app/settings" element={<Gate role="staff"><AdminSettings /></Gate>} />
      <Route path="/app/audit" element={<Gate role="staff"><AdminAudit /></Gate>} />
      <Route path="/app/import" element={<Gate role="staff"><AdminImport /></Gate>} />
      <Route path="/me" element={<Gate role="member"><MemberHome /></Gate>} />
      <Route path="/me/payments" element={<Gate role="member"><MemberPayments /></Gate>} />
      <Route path="/me/loan" element={<Gate role="member"><MemberLoan /></Gate>} />
      <Route path="/me/interest" element={<Gate role="member"><MemberInterest /></Gate>} />
      <Route path="/me/reports" element={<Gate role="member"><MemberReports /></Gate>} />
      <Route path="/me/month-sheet" element={<Gate role="member"><MemberMonthToCollect /></Gate>} />
      <Route path="/me/month-collected" element={<Gate role="member"><MemberMonthCollected /></Gate>} />
      <Route path="/me/monthly-collection" element={<Gate role="member"><MemberMonthlyCollection /></Gate>} />
      <Route path="/me/my-report" element={<Gate role="member"><MemberMonthReport /></Gate>} />
      <Route path="/me/more" element={<Gate role="member"><MemberMore /></Gate>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}
