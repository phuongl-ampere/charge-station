"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { ChargingStatus } from "../../../components/ChargingStatus";

export default function ChargeOrderPage() {
  const params = useParams<{ orderId: string }>();
  const orderId = decodeURIComponent(params.orderId);
  const [accessToken, setAccessToken] = useState<string | undefined>();

  useEffect(() => {
    const storageKey = `charge-token:${orderId}`;
    const hash = window.location.hash;
    const returnCapability = new URLSearchParams(hash.slice(1)).get(
      "charge_access",
    );
    if (hash) {
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    }
    if (returnCapability) {
      window.sessionStorage.setItem(storageKey, returnCapability);
      setAccessToken(returnCapability);
      return;
    }

    setAccessToken(window.sessionStorage.getItem(storageKey) ?? undefined);
  }, [orderId]);

  return <ChargingStatus orderId={orderId} accessToken={accessToken} />;
}
