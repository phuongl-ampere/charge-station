"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { ChargingStatus } from "../../../components/ChargingStatus";

export default function ChargeOrderPage() {
  const params = useParams<{ orderId: string }>();
  const orderId = decodeURIComponent(params.orderId);
  const [accessToken, setAccessToken] = useState<string | undefined>();

  useEffect(() => {
    setAccessToken(
      window.sessionStorage.getItem(`charge-token:${orderId}`) ?? undefined,
    );
  }, [orderId]);

  return <ChargingStatus orderId={orderId} accessToken={accessToken} />;
}
