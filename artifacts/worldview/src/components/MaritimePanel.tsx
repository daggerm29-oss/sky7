import { LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer } from "recharts";
import { FloatingPanel } from "./FloatingPanel";
import type { Ship, ShipFilters } from "./ShipsLayer";

interface Props {
  ships: Ship[];
  filters: ShipFilters;
  onFiltersChange: (next: ShipFilters) => void;
  loading: boolean;
  error: string | null;
  lastUpdate: Date | null;
  onClose: () => void;
}

// Render colours mirror ShipsLayer for visual consistency between the panel
// chips, the metric blocks, and the dots on the globe.
const C_TANKER = "#ff3b30";
const C_MIL    = "#3a8dff";
const C_AIS    = "#ffffff";

/**
 * MARITIME INTEL — floating data panel with three sections:
 *   1. FILTERS — toggle Military / Tanker / Global AIS classes on the globe.
 *   2. LIVE METRICS — counts derived from the latest /api/proxy/ships tick.
 *   3. REGIONAL ANALYTICS — placeholder Recharts canvases for Hormuz transit
 *      volume and Indian-subcontinent unloading. They render axes + grid
 *      today; pipe historical data into the `data` props later.
 *
 * Pinned header + scrollable body, matching the Aviation Intel layout so the
 * tactical aesthetic stays consistent across the windowing system.
 */
export function MaritimePanel({
  ships,
  filters,
  onFiltersChange,
  loading,
  error,
  lastUpdate,
  onClose,
}: Props) {
  // Derive live metrics from the unfiltered tick — filters only affect what
  // gets rendered on the globe, not what gets counted in the readout.
  let activeTankers = 0;
  let activeMilitary = 0;
  let activeGlobal = 0;
  for (const s of ships) {
    if (s.source === "AISSTREAM") activeGlobal++;
    else if (s.category === "TANKER") activeTankers++;
    else if (s.category === "MILITARY") activeMilitary++;
  }

  return (
    <FloatingPanel
      title="MARITIME INTEL"
      initialX={54}
      initialY={420}
      width={300}
      onClose={onClose}
    >
      <div style={{
        height: "100%", display: "flex", flexDirection: "column",
        overflow: "hidden", position: "relative",
      }}>
        {/* scan-line accent — same as Aviation Intel */}
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0, height: 2,
          background: "linear-gradient(90deg,transparent,rgba(0,255,255,0.6),transparent)",
          animation: "scan 4s linear infinite", zIndex: 2,
        }} />

        {/* HEADER (pinned) */}
        <div style={{ padding: "14px 16px 10px", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
            <div style={{
              width: 6, height: 6, borderRadius: "50%", background: "#00ffff",
              boxShadow: "0 0 6px rgba(0,255,255,0.8)",
              animation: "pulse-glow 2s ease-in-out infinite",
            }} />
            <span style={{
              fontSize: 13, letterSpacing: "0.35em", color: "#00ffff",
              textShadow: "0 0 8px rgba(0,255,255,0.5)",
              textTransform: "uppercase", fontWeight: 700,
            }}>MARITIME</span>
            <span style={{
              marginLeft: "auto", color: "rgba(0,255,255,0.5)", fontSize: 10,
              animation: "blink-anim 1.2s step-end infinite",
            }}>_</span>
          </div>
          <div style={{
            fontSize: 8, letterSpacing: "0.2em",
            color: "rgba(0,255,255,0.35)", textTransform: "uppercase",
          }}>FUSED RADAR · AISSTREAM · MARINETRAFFIC</div>
        </div>

        <SectionDivider />

        {/* SCROLLABLE BODY */}
        <div className="glow-scroll" style={{
          flex: 1, minHeight: 0, overflowY: "auto",
          display: "flex", flexDirection: "column",
        }}>
          {/* ── FILTERS ────────────────────────────────────────────────── */}
          <Section label="FILTERS">
            <FilterToggle
              label="MILITARY"
              dotColor={C_MIL}
              checked={filters.military}
              onChange={(v) => onFiltersChange({ ...filters, military: v })}
            />
            <FilterToggle
              label="TANKERS"
              dotColor={C_TANKER}
              checked={filters.tankers}
              onChange={(v) => onFiltersChange({ ...filters, tankers: v })}
            />
            <FilterToggle
              label="GLOBAL AIS"
              dotColor={C_AIS}
              checked={filters.globalAis}
              onChange={(v) => onFiltersChange({ ...filters, globalAis: v })}
            />
          </Section>

          <SectionDivider />

          {/* ── LIVE METRICS ───────────────────────────────────────────── */}
          <Section label="LIVE METRICS">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
              <MetricBlock label="TANKERS"  value={activeTankers}  color={C_TANKER} />
              <MetricBlock label="MILITARY" value={activeMilitary} color={C_MIL} />
              <MetricBlock label="GLOBAL"   value={activeGlobal}   color={C_AIS} />
            </div>
            {error && (
              <div style={{
                marginTop: 8, padding: "5px 8px",
                background: "rgba(255,50,50,0.07)",
                border: "1px solid rgba(255,50,50,0.2)",
                borderRadius: 2, fontSize: 9,
                color: "rgba(255,100,100,0.7)", letterSpacing: "0.1em",
              }}>⚠ {error}</div>
            )}
          </Section>

          <SectionDivider />

          {/* ── REGIONAL ANALYTICS ─────────────────────────────────────── */}
          <Section label="REGIONAL ANALYTICS">
            <ChartFrame title="HORMUZ TRANSIT VOLUME" subtitle="vessels / hr" />
            <div style={{ height: 8 }} />
            <ChartFrame title="INDIAN SUBCONTINENT UNLOADING" subtitle="dwt-kt / day" />
          </Section>
        </div>

        {/* FOOTER (pinned) */}
        <div style={{
          height: 1, margin: "0 16px",
          background: "linear-gradient(90deg,transparent,rgba(0,255,255,0.2),transparent)",
        }} />
        <div style={{
          padding: "6px 16px", flexShrink: 0,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <div style={{ fontSize: 8, color: "rgba(0,255,255,0.3)", letterSpacing: "0.08em" }}>
            {lastUpdate ? `UPD ${lastUpdate.toLocaleTimeString()}` : "INIT"}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            {loading && (
              <div style={{
                width: 5, height: 5, borderRadius: "50%",
                background: "rgba(0,255,255,0.8)",
                boxShadow: "0 0 4px rgba(0,255,255,0.8)",
                animation: "pulse-glow 2s ease-in-out infinite",
              }} />
            )}
            <div style={{ fontSize: 8, color: "rgba(0,255,255,0.3)", letterSpacing: "0.1em" }}>
              RADAR LIVE · 5s
            </div>
          </div>
        </div>
      </div>
    </FloatingPanel>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

function SectionDivider() {
  return (
    <div style={{
      height: 1, margin: "0 16px",
      background: "linear-gradient(90deg,transparent,rgba(0,255,255,0.18),transparent)",
    }} />
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: "10px 16px 12px" }}>
      <div style={{
        fontSize: 8, letterSpacing: "0.2em",
        color: "rgba(0,255,255,0.35)", textTransform: "uppercase",
        marginBottom: 8,
      }}>{label}</div>
      {children}
    </div>
  );
}

function FilterToggle({
  label, dotColor, checked, onChange,
}: { label: string; dotColor: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      style={{
        width: "100%", padding: "7px 10px", marginBottom: 4,
        background: checked ? "rgba(0,255,255,0.06)" : "rgba(0,255,255,0.015)",
        border: `1px solid ${checked ? "rgba(0,255,255,0.45)" : "rgba(0,255,255,0.12)"}`,
        borderRadius: 2, cursor: "pointer",
        display: "flex", alignItems: "center", gap: 9,
        fontFamily: "'Share Tech Mono','Courier New',monospace",
        transition: "all 0.12s ease",
      }}
      onMouseEnter={(e) => {
        if (!checked) e.currentTarget.style.background = "rgba(0,255,255,0.05)";
      }}
      onMouseLeave={(e) => {
        if (!checked) e.currentTarget.style.background = "rgba(0,255,255,0.015)";
      }}
    >
      {/* Custom checkbox box — matches the tactical aesthetic */}
      <span style={{
        width: 12, height: 12, flexShrink: 0,
        border: `1px solid ${checked ? "rgba(0,255,255,0.7)" : "rgba(0,255,255,0.3)"}`,
        background: checked ? "rgba(0,255,255,0.18)" : "transparent",
        borderRadius: 1,
        boxShadow: checked ? "0 0 6px rgba(0,255,255,0.5), inset 0 0 4px rgba(0,255,255,0.3)" : "none",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        fontSize: 10, color: "#00ffff", lineHeight: 1,
      }}>
        {checked ? "✓" : ""}
      </span>
      {/* Color dot for the class */}
      <span style={{
        width: 8, height: 8, borderRadius: "50%",
        background: dotColor,
        boxShadow: `0 0 5px ${dotColor}`,
      }} />
      <span style={{
        fontSize: 10, letterSpacing: "0.18em",
        color: checked ? "#00ffff" : "rgba(0,255,255,0.55)",
        textTransform: "uppercase",
      }}>{label}</span>
    </button>
  );
}

function MetricBlock({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      padding: 8,
      background: "rgba(0,255,255,0.03)",
      border: "1px solid rgba(0,255,255,0.1)",
      borderRadius: 2,
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 5, marginBottom: 4,
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: "50%",
          background: color, boxShadow: `0 0 4px ${color}`,
        }} />
        <span style={{
          fontSize: 7, letterSpacing: "0.15em",
          color: "rgba(0,255,255,0.45)", textTransform: "uppercase",
        }}>{label}</span>
      </div>
      <div style={{
        color, fontSize: 16, fontWeight: 700, lineHeight: 1,
        fontFamily: "'Share Tech Mono','Courier New',monospace",
        textShadow: `0 0 6px ${color}55`,
      }}>{value.toLocaleString()}</div>
    </div>
  );
}

/** Empty styled chart frame — Recharts grid + axes with no data series.
 *  Replace the empty `data` constant with real points to populate. */
function ChartFrame({ title, subtitle }: { title: string; subtitle: string }) {
  // Empty placeholder data — keeps the axes scaled so the grid renders.
  const data = [
    { t: 0,  v: 0 },
    { t: 24, v: 0 },
  ];

  return (
    <div style={{
      padding: "8px 8px 4px",
      background: "rgba(0,255,255,0.03)",
      border: "1px solid rgba(0,255,255,0.12)",
      borderRadius: 2,
      position: "relative",
    }}>
      <div style={{
        display: "flex", alignItems: "baseline", justifyContent: "space-between",
        marginBottom: 4,
      }}>
        <span style={{
          fontSize: 8, letterSpacing: "0.18em",
          color: "rgba(0,255,255,0.7)", textTransform: "uppercase",
        }}>{title}</span>
        <span style={{
          fontSize: 7, letterSpacing: "0.1em",
          color: "rgba(0,255,255,0.3)", textTransform: "uppercase",
        }}>{subtitle}</span>
      </div>
      <div style={{ width: "100%", height: 90, position: "relative" }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 6, left: -22, bottom: 0 }}>
            <CartesianGrid stroke="rgba(0,255,255,0.08)" strokeDasharray="2 3" />
            <XAxis
              dataKey="t"
              stroke="rgba(0,255,255,0.3)"
              tick={{ fontSize: 7, fill: "rgba(0,255,255,0.4)" }}
              tickLine={false}
              axisLine={{ stroke: "rgba(0,255,255,0.2)" }}
            />
            <YAxis
              stroke="rgba(0,255,255,0.3)"
              tick={{ fontSize: 7, fill: "rgba(0,255,255,0.4)" }}
              tickLine={false}
              axisLine={{ stroke: "rgba(0,255,255,0.2)" }}
              width={30}
            />
            <Line
              type="monotone"
              dataKey="v"
              stroke="rgba(0,255,255,0.55)"
              strokeWidth={1.2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
        {/* "AWAITING TELEMETRY" centered overlay until real data arrives */}
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          pointerEvents: "none",
        }}>
          <span style={{
            fontSize: 8, letterSpacing: "0.2em",
            color: "rgba(0,255,255,0.35)", textTransform: "uppercase",
            background: "rgba(2,4,8,0.55)", padding: "2px 6px", borderRadius: 1,
          }}>AWAITING TELEMETRY</span>
        </div>
      </div>
    </div>
  );
}
