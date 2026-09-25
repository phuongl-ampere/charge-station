"use client";

import {
  Activity,
  AlertTriangle,
  BatteryCharging,
  Copy,
  CreditCard,
  Landmark,
  LoaderCircle,
  LogOut,
  MapPin,
  Plus,
  QrCode,
  RefreshCw,
  RotateCcw,
  ServerCog,
  Wifi,
  X,
  Zap,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";

import {
  adminApi,
  type AdminApi,
  type AdminDeviceTimelineItem,
  type AdminOverview,
  type AdminPayment,
  type AdminSession,
  type AdminStation,
  type AdminStationQr,
} from "../lib/api";

type AdminOperationsApi = Pick<
  AdminApi,
  | "getOverview"
  | "getStations"
  | "createStation"
  | "getStationQr"
  | "rotateStationQr"
  | "getSessions"
  | "getPayments"
  | "getDeviceTimeline"
  | "stopSession"
  | "retryStart"
>;

type DashboardTab =
  "overview" | "stations" | "sessions" | "payments" | "devices";

type AdminDashboardProps = {
  accessToken: string;
  api?: AdminOperationsApi;
  onLogout: () => void;
};

const tabs: Array<{
  id: DashboardTab;
  label: string;
  icon: typeof Activity;
}> = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "stations", label: "Stations", icon: MapPin },
  { id: "sessions", label: "Sessions", icon: BatteryCharging },
  { id: "payments", label: "Payments", icon: CreditCard },
  { id: "devices", label: "Device activity", icon: ServerCog },
];

export function AdminDashboard({
  accessToken,
  api = adminApi,
  onLogout,
}: AdminDashboardProps) {
  const [activeTab, setActiveTab] = useState<DashboardTab>("overview");
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [stations, setStations] = useState<AdminStation[]>([]);
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [payments, setPayments] = useState<AdminPayment[]>([]);
  const [timeline, setTimeline] = useState<AdminDeviceTimelineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [commandSessionId, setCommandSessionId] = useState<string | null>(null);
  const [creatingStation, setCreatingStation] = useState(false);
  const [stationDialogOpen, setStationDialogOpen] = useState(false);
  const [qrStation, setQrStation] = useState<AdminStation | null>(null);
  const [stationQr, setStationQr] = useState<AdminStationQr | null>(null);
  const [qrLoading, setQrLoading] = useState(false);

  const refresh = useCallback(
    async (showRefresh = false) => {
      if (showRefresh) setRefreshing(true);
      try {
        const [
          nextOverview,
          nextStations,
          nextSessions,
          nextPayments,
          nextTimeline,
        ] = await Promise.all([
          api.getOverview(accessToken),
          api.getStations(accessToken),
          api.getSessions(accessToken),
          api.getPayments(accessToken),
          api.getDeviceTimeline(accessToken),
        ]);
        setOverview(nextOverview);
        setStations(nextStations);
        setSessions(nextSessions);
        setPayments(nextPayments);
        setTimeline(nextTimeline);
        setError(null);
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "The operations data could not be loaded",
        );
      } finally {
        setLoading(false);
        if (showRefresh) setRefreshing(false);
      }
    },
    [accessToken, api],
  );

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  async function runSessionCommand(
    sessionId: string,
    command: "stop" | "retry",
  ): Promise<void> {
    setCommandSessionId(sessionId);
    setError(null);
    try {
      if (command === "stop") {
        await api.stopSession(sessionId, accessToken);
      } else {
        await api.retryStart(sessionId, accessToken);
      }
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The device command was not accepted",
      );
    } finally {
      setCommandSessionId(null);
    }
  }

  async function showStationQr(station: AdminStation): Promise<void> {
    setQrStation(station);
    setStationQr(null);
    setQrLoading(true);
    setError(null);
    try {
      setStationQr(await api.getStationQr(station.id, accessToken));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The station QR could not be generated",
      );
    } finally {
      setQrLoading(false);
    }
  }

  async function createStation(input: {
    code: string;
    deviceId?: string;
  }): Promise<void> {
    setCreatingStation(true);
    setError(null);
    try {
      const station = await api.createStation(input, accessToken);
      setStationDialogOpen(false);
      await refresh();
      await showStationQr(station);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The station could not be created",
      );
    } finally {
      setCreatingStation(false);
    }
  }

  async function rotateStationQr(): Promise<void> {
    if (!qrStation) return;
    setQrLoading(true);
    setError(null);
    try {
      setStationQr(await api.rotateStationQr(qrStation.id, accessToken));
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The station QR could not be rotated",
      );
    } finally {
      setQrLoading(false);
    }
  }

  return (
    <main className="admin-shell">
      <aside className="admin-sidebar" aria-label="Operations navigation">
        <div className="admin-identity">
          <span className="admin-identity-mark" aria-hidden="true">
            <Zap size={18} />
          </span>
          <span>
            <strong>Charge Station</strong>
            <small>Operations</small>
          </span>
        </div>
        <nav className="admin-navigation">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                className="admin-nav-button"
                data-active={activeTab === tab.id}
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                type="button"
              >
                <Icon size={17} aria-hidden="true" />
                {tab.label}
              </button>
            );
          })}
        </nav>
        <div className="admin-sidebar-foot">
          <span>
            <Wifi size={14} aria-hidden="true" />
            Live polling
          </span>
          <button
            className="admin-logout"
            onClick={onLogout}
            title="Sign out"
            type="button"
          >
            <LogOut size={16} aria-hidden="true" />
            Sign out
          </button>
        </div>
      </aside>

      <section className="admin-workspace">
        <header className="admin-header">
          <div>
            <p className="eyebrow">Charge station control</p>
            <h1>{tabHeading(activeTab)}</h1>
          </div>
          <button
            className="admin-refresh"
            disabled={refreshing}
            onClick={() => void refresh(true)}
            title="Refresh operations data"
            type="button"
          >
            {refreshing ? (
              <LoaderCircle
                className="admin-spin"
                size={17}
                aria-hidden="true"
              />
            ) : (
              <RefreshCw size={17} aria-hidden="true" />
            )}
            Refresh
          </button>
        </header>

        {error ? (
          <p className="admin-error" role="alert">
            {error}
          </p>
        ) : null}
        {loading ? (
          <div className="admin-loading">
            <LoaderCircle className="admin-spin" size={20} aria-hidden="true" />
            Loading operations data
          </div>
        ) : (
          <>
            {activeTab === "overview" && overview ? (
              <OverviewPanel
                overview={overview}
                onStations={() => setActiveTab("stations")}
              />
            ) : null}
            {activeTab === "stations" ? (
              <StationsPanel
                commandSessionId={commandSessionId}
                onCommand={runSessionCommand}
                onCreateStation={() => setStationDialogOpen(true)}
                onShowStationQr={(station) => void showStationQr(station)}
                stations={stations}
              />
            ) : null}
            {activeTab === "sessions" ? (
              <SessionsPanel
                commandSessionId={commandSessionId}
                onCommand={runSessionCommand}
                sessions={sessions}
              />
            ) : null}
            {activeTab === "payments" ? (
              <PaymentsPanel payments={payments} />
            ) : null}
            {activeTab === "devices" ? (
              <DeviceTimelinePanel timeline={timeline} />
            ) : null}
          </>
        )}
      </section>
      <CreateStationDialog
        onClose={() => setStationDialogOpen(false)}
        onCreate={(input) => void createStation(input)}
        open={stationDialogOpen}
        submitting={creatingStation}
      />
      <StationQrDialog
        loading={qrLoading}
        onClose={() => {
          setQrStation(null);
          setStationQr(null);
        }}
        onRotate={() => void rotateStationQr()}
        qr={stationQr}
        station={qrStation}
      />
    </main>
  );
}

function OverviewPanel({
  overview,
  onStations,
}: {
  overview: AdminOverview;
  onStations: () => void;
}) {
  return (
    <div className="admin-panel-stack">
      <section className="admin-metric-grid" aria-label="Operations summary">
        <Metric
          icon={MapPin}
          label="Stations"
          note={`${overview.connectors.total} connectors`}
          value={String(overview.stations)}
        />
        <Metric
          icon={BatteryCharging}
          label="Charging now"
          note={`${overview.sessions.active} active sessions`}
          tone="signal"
          value={String(overview.sessions.charging)}
        />
        <Metric
          icon={Landmark}
          label="Paid today"
          note="Verified PayOS payments"
          value={formatVnd(overview.revenueTodayVnd)}
        />
        <Metric
          icon={CreditCard}
          label="Payment pending"
          note="Reserved connectors"
          tone="gold"
          value={String(overview.paymentsPending)}
        />
        <Metric
          icon={AlertTriangle}
          label="Needs attention"
          note={`${overview.connectors.offline} connector offline`}
          tone="coral"
          value={String(
            overview.sessions.attention + overview.connectors.offline,
          )}
        />
      </section>

      <section className="admin-section" aria-labelledby="attention-heading">
        <div className="admin-section-heading">
          <div>
            <p className="eyebrow">Operational queue</p>
            <h2 id="attention-heading">Needs attention</h2>
          </div>
          <button
            className="admin-text-button"
            onClick={onStations}
            type="button"
          >
            Open stations
          </button>
        </div>
        {overview.alerts.length ? (
          <div className="admin-alert-list">
            {overview.alerts.map((alert) => (
              <div
                className="admin-alert-row"
                key={`${alert.category}:${alert.connectorCode}:${alert.sessionId ?? ""}`}
              >
                <AlertTriangle size={17} aria-hidden="true" />
                <div>
                  <strong>{alert.connectorCode}</strong>
                  <span>{alert.message}</span>
                </div>
                <small>{alert.stationCode}</small>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={Activity} message="No current operational alerts" />
        )}
      </section>
    </div>
  );
}

function StationsPanel({
  stations,
  commandSessionId,
  onCommand,
  onCreateStation,
  onShowStationQr,
}: {
  stations: AdminStation[];
  commandSessionId: string | null;
  onCommand: (sessionId: string, command: "stop" | "retry") => Promise<void>;
  onCreateStation: () => void;
  onShowStationQr: (station: AdminStation) => void;
}) {
  return (
    <section className="admin-section" aria-labelledby="stations-heading">
      <div className="admin-section-heading">
        <div>
          <p className="eyebrow">Live equipment state</p>
          <h2 id="stations-heading">Stations and connectors</h2>
        </div>
        <div className="admin-station-actions">
          <span className="admin-section-count">
            {stations.length} stations
          </span>
          <button
            className="admin-add-station"
            onClick={onCreateStation}
            type="button"
          >
            <Plus size={15} aria-hidden="true" />
            Add station
          </button>
        </div>
      </div>
      <div className="admin-station-list">
        {stations.map((station) => (
          <article className="admin-station-row" key={station.id}>
            <div className="admin-station-meta">
              <strong>{station.code}</strong>
              <small>{station.deviceId ?? "No device mapping"}</small>
              <button
                className="admin-station-qr-button"
                onClick={() => onShowStationQr(station)}
                type="button"
              >
                <QrCode size={15} aria-hidden="true" />
                Station QR
              </button>
            </div>
            <div className="admin-connector-list">
              <StationTelemetry telemetry={station.telemetry} />
              {station.connectors.map((connector) => (
                <div className="admin-connector-row" key={connector.id}>
                  <div className="admin-connector-title">
                    <span
                      className={`admin-status is-${connector.status.toLowerCase()}`}
                    >
                      {connector.status}
                    </span>
                    <strong>{connector.code}</strong>
                    <small>
                      {connector.hourlyPriceVnd
                        ? `${formatVnd(connector.hourlyPriceVnd)} / hour`
                        : "No price plan"}
                    </small>
                  </div>
                  {connector.activeSession ? (
                    <>
                      <div className="admin-session-readout">
                        <span>Check-in</span>
                        <strong>
                          {formatDateTime(connector.activeSession.checkInAt)}
                        </strong>
                      </div>
                      <div className="admin-session-readout">
                        <span>Remaining</span>
                        <strong>
                          {formatRemaining(
                            connector.activeSession.estimatedRemainingSeconds,
                          )}
                        </strong>
                      </div>
                      <SessionAction
                        onCommand={onCommand}
                        pending={
                          commandSessionId === connector.activeSession.id
                        }
                        session={connector.activeSession}
                      />
                    </>
                  ) : (
                    <div className="admin-idle-readout">
                      Available for the next session
                    </div>
                  )}
                </div>
              ))}
            </div>
          </article>
        ))}
        {!stations.length ? (
          <EmptyState icon={MapPin} message="No stations are configured" />
        ) : null}
      </div>
    </section>
  );
}

function StationTelemetry({
  telemetry,
}: {
  telemetry: AdminStation["telemetry"];
}) {
  if (telemetry.status === "UNAVAILABLE") {
    return (
      <section
        aria-label="Live meter telemetry"
        className="admin-telemetry-strip admin-telemetry-unavailable"
      >
        <div className="admin-telemetry-meta">
          <span>Live meter</span>
        </div>
        <p role="status">Telemetry unavailable</p>
        <small>No recent device sample is available for this station.</small>
      </section>
    );
  }

  return (
    <section
      aria-label="Live meter telemetry"
      className="admin-telemetry-strip"
    >
      <div className="admin-telemetry-meta">
        <span
          className={
            telemetry.relayState === true
              ? "is-on"
              : telemetry.relayState === false
                ? "is-off"
                : undefined
          }
        >
          {telemetry.relayState === null
            ? "Relay state unknown"
            : telemetry.relayState
              ? "Relay on"
              : "Relay off"}
        </span>
        <time dateTime={telemetry.eventAt}>
          Sample {formatDateTime(telemetry.eventAt)}
        </time>
      </div>
      <dl className="admin-telemetry-readings">
        <TelemetryReading
          label="Volt"
          value={formatVoltage(telemetry.voltageV)}
        />
        <TelemetryReading
          label="Amp"
          value={formatCurrent(telemetry.currentA)}
        />
        <TelemetryReading label="Power" value={formatPower(telemetry.powerW)} />
        <TelemetryReading
          label="Energy"
          value={formatEnergy(telemetry.energyKwh)}
        />
        <TelemetryReading
          label="Remain"
          value={formatRemaining(telemetry.remainingSeconds)}
        />
      </dl>
    </section>
  );
}

function TelemetryReading({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function CreateStationDialog({
  open,
  submitting,
  onClose,
  onCreate,
}: {
  open: boolean;
  submitting: boolean;
  onClose: () => void;
  onCreate: (input: { code: string; deviceId?: string }) => void;
}) {
  const [code, setCode] = useState("");
  const [deviceId, setDeviceId] = useState("");

  if (!open) return null;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onCreate({
      code,
      ...(deviceId.trim() ? { deviceId } : {}),
    });
  }

  return (
    <div className="admin-modal-backdrop" role="presentation">
      <section
        aria-labelledby="create-station-heading"
        aria-modal="true"
        className="admin-modal"
        role="dialog"
      >
        <div className="admin-modal-heading">
          <div>
            <p className="eyebrow">Station configuration</p>
            <h2 id="create-station-heading">Add station</h2>
          </div>
          <button
            aria-label="Close create station"
            className="admin-modal-close"
            disabled={submitting}
            onClick={onClose}
            type="button"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <form className="admin-station-form" onSubmit={submit}>
          <label htmlFor="station-code">Station code</label>
          <input
            autoCapitalize="characters"
            autoComplete="off"
            id="station-code"
            maxLength={64}
            onChange={(event) => setCode(event.target.value)}
            placeholder="ST02"
            required
            value={code}
          />
          <label htmlFor="station-device-id">Device ID</label>
          <input
            autoComplete="off"
            id="station-device-id"
            maxLength={120}
            onChange={(event) => setDeviceId(event.target.value)}
            placeholder="dev_ST02"
            value={deviceId}
          />
          <div className="admin-modal-actions">
            <button
              className="admin-modal-cancel"
              disabled={submitting}
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
            <button
              className="admin-modal-submit"
              disabled={submitting}
              type="submit"
            >
              {submitting ? "Creating" : "Create station"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function StationQrDialog({
  station,
  qr,
  loading,
  onClose,
  onRotate,
}: {
  station: AdminStation | null;
  qr: AdminStationQr | null;
  loading: boolean;
  onClose: () => void;
  onRotate: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!station) return null;

  async function copyUrl(): Promise<void> {
    if (!qr) return;
    await navigator.clipboard?.writeText(qr.scanUrl);
    setCopied(true);
  }

  return (
    <div className="admin-modal-backdrop" role="presentation">
      <section
        aria-labelledby="station-qr-heading"
        aria-modal="true"
        className="admin-modal admin-qr-modal"
        role="dialog"
      >
        <div className="admin-modal-heading">
          <div>
            <p className="eyebrow">{station.code}</p>
            <h2 id="station-qr-heading">Station QR</h2>
          </div>
          <button
            aria-label="Close station QR"
            className="admin-modal-close"
            disabled={loading}
            onClick={onClose}
            type="button"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {loading || !qr ? (
          <div className="admin-qr-loading">
            <LoaderCircle className="admin-spin" size={20} aria-hidden="true" />
            Generating encrypted QR
          </div>
        ) : (
          <>
            <div className="admin-qr-image">
              <QRCodeSVG
                bgColor="#ffffff"
                fgColor="#102326"
                level="M"
                size={192}
                value={qr.scanUrl}
              />
            </div>
            <label htmlFor="station-qr-url">Encrypted station QR URL</label>
            <input
              className="admin-qr-url"
              id="station-qr-url"
              readOnly
              value={qr.scanUrl}
            />
            <p className="admin-qr-version">QR version {qr.qrVersion}</p>
            <div className="admin-modal-actions">
              <button
                className="admin-modal-cancel"
                onClick={() => void copyUrl()}
                type="button"
              >
                <Copy size={15} aria-hidden="true" />
                {copied ? "Copied" : "Copy QR URL"}
              </button>
              <button
                className="admin-rotate-button"
                onClick={onRotate}
                type="button"
              >
                <RotateCcw size={15} aria-hidden="true" />
                Rotate QR
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function SessionsPanel({
  sessions,
  commandSessionId,
  onCommand,
}: {
  sessions: AdminSession[];
  commandSessionId: string | null;
  onCommand: (sessionId: string, command: "stop" | "retry") => Promise<void>;
}) {
  return (
    <TableSection
      eyebrow="Charging ledger"
      heading="Sessions"
      count={`${sessions.length} latest`}
    >
      <table className="admin-table">
        <thead>
          <tr>
            <th>Station / connector</th>
            <th>Status</th>
            <th>Amount</th>
            <th>Check-in</th>
            <th>Check-out</th>
            <th>Run time</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id}>
              <td>
                <strong>{session.connectorCode}</strong>
                <small>{session.stationName}</small>
              </td>
              <td>
                <span
                  className={`admin-status is-${session.status.toLowerCase()}`}
                >
                  {session.status}
                </span>
              </td>
              <td>
                {formatVnd(session.amountVnd)}
                <small>{session.durationMinutes} min booked</small>
              </td>
              <td>{formatDateTime(session.checkInAt)}</td>
              <td>{formatDateTime(session.checkOutAt)}</td>
              <td>
                {session.actualDurationSeconds === null
                  ? formatRemaining(session.estimatedRemainingSeconds)
                  : formatDuration(session.actualDurationSeconds)}
              </td>
              <td>
                <SessionAction
                  onCommand={onCommand}
                  pending={commandSessionId === session.id}
                  session={session}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!sessions.length ? (
        <EmptyState icon={BatteryCharging} message="No charging sessions yet" />
      ) : null}
    </TableSection>
  );
}

function PaymentsPanel({ payments }: { payments: AdminPayment[] }) {
  return (
    <TableSection
      eyebrow="PayOS reconciliation"
      heading="Payments"
      count={`${payments.length} latest`}
    >
      <table className="admin-table">
        <thead>
          <tr>
            <th>PayOS order</th>
            <th>Connector</th>
            <th>Amount</th>
            <th>Payment state</th>
            <th>Cancellation</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((payment) => (
            <tr key={payment.id}>
              <td>
                <strong>{payment.payosOrderCode}</strong>
                <small>{payment.orderId}</small>
              </td>
              <td>{payment.connectorCode}</td>
              <td>{formatVnd(payment.amountVnd)}</td>
              <td>
                <span
                  className={`admin-status is-${payment.status.toLowerCase()}`}
                >
                  {payment.status}
                </span>
              </td>
              <td>{payment.cancellationStatus}</td>
              <td>{formatDateTime(payment.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!payments.length ? (
        <EmptyState icon={CreditCard} message="No PayOS payments yet" />
      ) : null}
    </TableSection>
  );
}

function DeviceTimelinePanel({
  timeline,
}: {
  timeline: AdminDeviceTimelineItem[];
}) {
  return (
    <section className="admin-section" aria-labelledby="timeline-heading">
      <div className="admin-section-heading">
        <div>
          <p className="eyebrow">Command and event activity</p>
          <h2 id="timeline-heading">Device activity</h2>
        </div>
        <span className="admin-section-count">{timeline.length} latest</span>
      </div>
      <div className="admin-timeline">
        {timeline.map((item) => (
          <div className="admin-timeline-row" key={`${item.kind}:${item.id}`}>
            <span
              className={`admin-timeline-kind is-${item.kind.toLowerCase()}`}
            >
              {item.kind}
            </span>
            <strong>{item.type}</strong>
            <span>{item.connectorCode}</span>
            <span>{item.status}</span>
            <time>{formatDateTime(item.at)}</time>
          </div>
        ))}
        {!timeline.length ? (
          <EmptyState
            icon={ServerCog}
            message="No device commands or events yet"
          />
        ) : null}
      </div>
    </section>
  );
}

function TableSection({
  eyebrow,
  heading,
  count,
  children,
}: {
  eyebrow: string;
  heading: string;
  count: string;
  children: ReactNode;
}) {
  return (
    <section className="admin-section" aria-labelledby={`${heading}-heading`}>
      <div className="admin-section-heading">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2 id={`${heading}-heading`}>{heading}</h2>
        </div>
        <span className="admin-section-count">{count}</span>
      </div>
      <div className="admin-table-wrap">{children}</div>
    </section>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  note,
  tone,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  note: string;
  tone?: "signal" | "gold" | "coral";
}) {
  return (
    <article className="admin-metric" data-tone={tone}>
      <Icon size={18} aria-hidden="true" />
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

function SessionAction({
  session,
  pending,
  onCommand,
}: {
  session: AdminSession;
  pending: boolean;
  onCommand: (sessionId: string, command: "stop" | "retry") => Promise<void>;
}) {
  if (session.status === "START_FAILED") {
    return (
      <button
        className="admin-command-button is-retry"
        disabled={pending}
        onClick={() => void onCommand(session.id, "retry")}
        type="button"
      >
        Retry start
      </button>
    );
  }

  if (
    session.status === "STARTING" ||
    session.status === "CHARGING" ||
    session.status === "STOPPING" ||
    session.status === "DEVICE_OFFLINE"
  ) {
    return (
      <button
        className="admin-command-button is-stop"
        disabled={pending || session.status === "STOPPING"}
        onClick={() => void onCommand(session.id, "stop")}
        type="button"
      >
        Stop charging
      </button>
    );
  }
  return null;
}

function EmptyState({
  icon: Icon,
  message,
}: {
  icon: typeof Activity;
  message: string;
}) {
  return (
    <div className="admin-empty">
      <Icon size={19} aria-hidden="true" />
      {message}
    </div>
  );
}

function tabHeading(tab: DashboardTab): string {
  const headings: Record<DashboardTab, string> = {
    overview: "Operations overview",
    stations: "Station management",
    sessions: "Charging sessions",
    payments: "Payment operations",
    devices: "Device activity",
  };
  return headings[tab];
}

function formatVnd(amount: number): string {
  return `${new Intl.NumberFormat("en-US").format(amount)} VND`;
}

function formatDateTime(value: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Invalid time";
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "short",
    timeZone: "Asia/Ho_Chi_Minh",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("day")} ${part("month")}, ${part("hour")}:${part("minute")}`;
}

function formatRemaining(seconds: number | null): string {
  if (seconds === null) return "No device time";
  return formatDuration(seconds);
}

function formatVoltage(value: number | null): string {
  return value === null ? "No reading" : `${value.toFixed(1)} V`;
}

function formatCurrent(value: number | null): string {
  return value === null ? "No reading" : `${value.toFixed(1)} A`;
}

function formatPower(value: number | null): string {
  if (value === null) return "No reading";
  return value >= 1_000
    ? `${(value / 1_000).toFixed(2)} kW`
    : `${value.toFixed(0)} W`;
}

function formatEnergy(value: number | null): string {
  return value === null ? "No reading" : `${value.toFixed(3)} kWh`;
}

function formatDuration(seconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}
