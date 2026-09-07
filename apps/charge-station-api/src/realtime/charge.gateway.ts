import {
  BadRequestException,
  ForbiddenException,
  Inject,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import jwt from "jsonwebtoken";
import type { Server, Socket } from "socket.io";
import { DataSource } from "typeorm";

import { AuthService } from "../auth/auth.service.js";
import { ChargingSession, Order } from "../database/data-source.js";

const REALTIME_TOKEN_TYPE = "charge-realtime";
const REALTIME_TOKEN_TTL = "15m";

interface SubscribePayload {
  orderId?: unknown;
  sessionId?: unknown;
  accessToken?: unknown;
}

interface RealtimeTokenPayload {
  type: typeof REALTIME_TOKEN_TYPE;
  orderId: string;
}

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL ?? "http://localhost:3000",
  },
})
export class ChargeGateway {
  @WebSocketServer()
  private server!: Server;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(AuthService) private readonly authService: AuthService,
  ) {}

  issueAccessToken(orderId: string): string {
    return jwt.sign(
      {
        type: REALTIME_TOKEN_TYPE,
        orderId,
      } satisfies RealtimeTokenPayload,
      getJwtSecret(),
      { expiresIn: REALTIME_TOKEN_TTL },
    );
  }

  @SubscribeMessage("subscribe")
  async subscribe(
    @ConnectedSocket() client: Pick<Socket, "join">,
    @MessageBody() payload: SubscribePayload,
  ): Promise<{ subscribed: string }> {
    const target = readSubscriptionTarget(payload);
    const token = readAccessToken(payload);
    const orderId = await this.resolveOrderId(target);
    await this.authorizeOrder(orderId, token);

    const room =
      target.kind === "order"
        ? orderRoom(orderId)
        : sessionRoom(target.sessionId);
    client.join(room);
    return { subscribed: room };
  }

  publishOrder(
    orderId: string,
    event: "payment.updated",
    payload: unknown,
  ): void {
    this.server.to(orderRoom(orderId)).emit(event, payload);
  }

  publishSession(
    sessionId: string,
    event: "session.updated" | "device.updated",
    payload: unknown,
  ): void {
    this.server.to(sessionRoom(sessionId)).emit(event, payload);
  }

  private async resolveOrderId(
    target:
      | { kind: "order"; orderId: string }
      | { kind: "session"; sessionId: string },
  ): Promise<string> {
    if (target.kind === "order") {
      const order = await this.dataSource
        .getRepository(Order)
        .findOneBy({ id: target.orderId });
      if (!order) {
        throw new ForbiddenException("Order subscription is not authorized");
      }
      return order.id;
    }

    const session = await this.dataSource
      .getRepository(ChargingSession)
      .findOneBy({ id: target.sessionId });
    if (!session) {
      throw new ForbiddenException("Session subscription is not authorized");
    }
    return session.order.id;
  }

  private async authorizeOrder(orderId: string, token: string): Promise<void> {
    const realtimeToken = verifyRealtimeToken(token);
    if (realtimeToken) {
      if (realtimeToken.orderId !== orderId) {
        throw new ForbiddenException("Subscription token does not match order");
      }
      return;
    }

    const user = this.authService.verifyToken(token);
    const order = await this.dataSource
      .getRepository(Order)
      .findOneBy({ id: orderId });
    if (!order || order.user?.id !== user.sub) {
      throw new ForbiddenException("Order subscription is not authorized");
    }
  }
}

function readSubscriptionTarget(
  payload: SubscribePayload,
): { kind: "order"; orderId: string } | { kind: "session"; sessionId: string } {
  const hasOrderId = typeof payload?.orderId === "string" && !!payload.orderId;
  const hasSessionId =
    typeof payload?.sessionId === "string" && !!payload.sessionId;
  if (hasOrderId === hasSessionId) {
    throw new BadRequestException(
      "Subscribe payload must contain exactly one orderId or sessionId",
    );
  }
  return hasOrderId
    ? { kind: "order", orderId: payload.orderId as string }
    : { kind: "session", sessionId: payload.sessionId as string };
}

function readAccessToken(payload: SubscribePayload): string {
  if (typeof payload?.accessToken !== "string" || !payload.accessToken) {
    throw new ForbiddenException("Subscription token is required");
  }
  return payload.accessToken;
}

function verifyRealtimeToken(token: string): RealtimeTokenPayload | null {
  try {
    const payload = jwt.verify(token, getJwtSecret());
    if (
      typeof payload === "object" &&
      payload !== null &&
      payload.type === REALTIME_TOKEN_TYPE &&
      typeof payload.orderId === "string"
    ) {
      return { type: REALTIME_TOKEN_TYPE, orderId: payload.orderId };
    }
  } catch {
    return null;
  }
  return null;
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error("JWT_SECRET must be set");
  }
  return secret;
}

function orderRoom(orderId: string): string {
  return `order:${orderId}`;
}

function sessionRoom(sessionId: string): string {
  return `session:${sessionId}`;
}
