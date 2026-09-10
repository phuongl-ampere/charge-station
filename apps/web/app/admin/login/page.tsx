"use client";

import { useRouter } from "next/navigation";

import { AdminLogin } from "../../../components/AdminLogin";

const adminTokenKey = "charge-station:admin-token";

export default function AdminLoginPage() {
  const router = useRouter();

  function onAuthenticated(accessToken: string): void {
    window.sessionStorage.setItem(adminTokenKey, accessToken);
    router.replace("/admin");
  }

  return <AdminLogin onAuthenticated={onAuthenticated} />;
}
