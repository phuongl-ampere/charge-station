import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AdminDashboard } from "./AdminDashboard";

const api = {
  getOverview: vi.fn().mockResolvedValue({
    stations: 1,
    connectors: { total: 2, available: 1, occupied: 1, offline: 0 },
    sessions: { active: 1, charging: 1, attention: 0 },
    revenueTodayVnd: 15_000,
    paymentsPending: 1,
    alerts: [],
  }),
  getStations: vi.fn().mockResolvedValue([
    {
      id: "station-1",
      code: "ST01",
      name: "Demo Station",
      deviceId: "dev_ST01",
      telemetry: { status: "UNAVAILABLE" },
      connectors: [
        {
          id: "connector-1",
          code: "ST01-C01",
          status: "OCCUPIED",
          hourlyPriceVnd: 5000,
          activeSession: {
            id: "session-1",
            orderId: "order-1",
            status: "CHARGING",
            stationCode: "ST01",
            stationName: "Demo Station",
            connectorCode: "ST01-C01",
            amountVnd: 10_000,
            durationMinutes: 120,
            requestedAt: "2026-09-10T00:00:00.000Z",
            checkInAt: "2026-09-10T08:00:00.000Z",
            expectedEndAt: "2026-09-10T10:00:00.000Z",
            checkOutAt: null,
            actualDurationSeconds: null,
            estimatedRemainingSeconds: 5400,
            lastDeviceEventAt: "2026-09-10T08:30:00.000Z",
            operationalWarning: null,
          },
        },
      ],
    },
  ]),
  getSessions: vi.fn().mockResolvedValue([]),
  getPayments: vi.fn().mockResolvedValue([]),
  getDeviceTimeline: vi.fn().mockResolvedValue([]),
  createStation: vi.fn().mockResolvedValue({
    id: "station-2",
    code: "ST02",
    name: "ST02",
    deviceId: "dev_ST02",
    telemetry: { status: "UNAVAILABLE" },
    qrVersion: 1,
    connectors: [],
  }),
  getStationQr: vi.fn().mockResolvedValue({
    stationId: "station-1",
    qrVersion: 1,
    scanUrl: "https://charge.example.test/scan/station/ciphertext-token",
  }),
  rotateStationQr: vi.fn().mockResolvedValue({
    stationId: "station-1",
    qrVersion: 2,
    scanUrl: "https://charge.example.test/scan/station/rotated-ciphertext",
  }),
  stopSession: vi.fn().mockResolvedValue({ accepted: true }),
  retryStart: vi.fn().mockResolvedValue({ accepted: true }),
};

describe("AdminDashboard", () => {
  it("renders voltage current power energy and remaining time", async () => {
    const user = userEvent.setup();
    const apiWithTelemetry = {
      ...api,
      getStations: vi.fn().mockResolvedValue([
        {
          id: "station-1",
          code: "ST01",
          name: "Demo Station",
          deviceId: "dev_ST01",
          telemetry: {
            status: "AVAILABLE",
            eventAt: "2026-09-25T01:00:02.000Z",
            relayState: true,
            sessionId: null,
            lastStopReason: null,
            voltageV: 230.4,
            currentA: 10.2,
            powerW: 2350,
            energyKwh: 0.0174,
            remainingSeconds: 3540,
          },
          connectors: [],
        },
      ]),
    };
    render(
      <AdminDashboard
        accessToken="admin"
        api={apiWithTelemetry}
        onLogout={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Stations" }));

    expect(await screen.findByText("230.4 V")).toBeInTheDocument();
    expect(screen.getByText("10.2 A")).toBeInTheDocument();
    expect(screen.getByText("2.35 kW")).toBeInTheDocument();
    expect(screen.getByText("0.017 kWh")).toBeInTheDocument();
    expect(screen.getByText("0h 59m")).toBeInTheDocument();
  });

  it("renders unavailable telemetry without false zero values", async () => {
    const user = userEvent.setup();
    const apiWithoutTelemetry = {
      ...api,
      getStations: vi.fn().mockResolvedValue([
        {
          id: "station-1",
          code: "ST01",
          name: "Demo Station",
          deviceId: "dev_ST01",
          telemetry: { status: "UNAVAILABLE" },
          connectors: [],
        },
      ]),
    };
    render(
      <AdminDashboard
        accessToken="admin"
        api={apiWithoutTelemetry}
        onLogout={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Stations" }));

    expect(await screen.findByText("Telemetry unavailable")).toBeInTheDocument();
    expect(screen.queryByText("0.0 V")).not.toBeInTheDocument();
  });

  it("shows live money and lets an operator stop an occupied connector", async () => {
    const user = userEvent.setup();
    render(
      <AdminDashboard
        accessToken="operations-token"
        api={api}
        onLogout={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Operations overview" }),
    ).toBeVisible();
    expect(screen.getByText("15,000 VND")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Stations" }));

    expect(await screen.findByText("ST01-C01")).toBeVisible();
    expect(screen.getByText("Check-in")).toBeVisible();
    expect(screen.getByText("10 Sep, 15:00")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Stop charging" }));
    await waitFor(() =>
      expect(api.stopSession).toHaveBeenCalledWith(
        "session-1",
        "operations-token",
      ),
    );
  });

  it("creates a station and exposes only its encrypted QR scan URL", async () => {
    const user = userEvent.setup();
    render(
      <AdminDashboard
        accessToken="admin-token"
        api={api}
        onLogout={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Stations" }));
    await user.click(screen.getByRole("button", { name: "Add station" }));
    await user.type(screen.getByLabelText("Station code"), "st02");
    await user.type(screen.getByLabelText("Device ID"), "dev_ST02");
    await user.click(screen.getByRole("button", { name: "Create station" }));

    await waitFor(() =>
      expect(api.createStation).toHaveBeenCalledWith(
        {
          code: "st02",
          deviceId: "dev_ST02",
        },
        "admin-token",
      ),
    );
    expect(api.getStationQr).toHaveBeenCalledWith("station-2", "admin-token");
    expect(
      await screen.findByDisplayValue(
        "https://charge.example.test/scan/station/ciphertext-token",
      ),
    ).toBeVisible();
  });
});
