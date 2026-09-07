import { io, type Socket } from "socket.io-client";

import { localApiOrigin } from "./api";

export interface ChargeSocket {
  connected: boolean;
  emit(
    event: "subscribe",
    payload: {
      orderId?: string;
      sessionId?: string;
      accessToken: string;
    },
  ): void;
  on(event: string, listener: (payload?: unknown) => void): void;
  off(event: string, listener?: (payload?: unknown) => void): void;
  disconnect?(): void;
}

export function createChargeSocket(): ChargeSocket {
  if (process.env.NEXT_PUBLIC_MOCK_SOCKET === "1") {
    return {
      connected: false,
      emit: () => undefined,
      on: () => undefined,
      off: () => undefined,
    };
  }
  return io(localApiOrigin, {
    transports: ["websocket", "polling"],
  }) as Socket;
}
