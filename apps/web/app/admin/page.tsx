"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { AdminDashboard } from "../../components/AdminDashboard";

const adminTokenKey = "charge-station:admin-token";

export default function AdminPage() {
  const router = useRouter();
  const [accessToken, setAccessToken] = useState<string | null>(null);

  useEffect(() => {
    const token = window.sessionStorage.getItem(adminTokenKey);
    if (!token) {
      router.replace("/admin/login");
      return;
    }
    setAccessToken(token);
  }, [router]);

  function logout(): void {
    window.sessionStorage.removeItem(adminTokenKey);
    router.replace("/admin/login");
  }

  if (!accessToken) {
    return <main className="admin-route-loading">Checking access</main>;
  }

  return <AdminDashboard accessToken={accessToken} onLogout={logout} />;
}
