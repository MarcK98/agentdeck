// The AgentDeck logo mark — two 45°-rotated rounded squares stacked with a
// small vertical offset: a muted back square and a brand-gradient front square
// with a soft glow. Sized by `s` (front-square edge in px); the wrapper scales
// proportionally. Matches the mockup mark used across desktop/mobile/site.

export default function Brand({ s = 13, glow = true }: { s?: number; glow?: boolean }) {
  const w = Math.round(s * 1.7);
  const h = Math.round(s * 1.85);
  const off = Math.round(s * 0.46);
  const r = Math.max(2, Math.round(s * 0.25));
  return (
    <div style={{ position: "relative", width: w, height: h, flex: "none" }} aria-hidden>
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 1,
          width: s,
          height: s,
          background: "#2c3060",
          transform: "translateX(-50%) rotate(45deg)",
          borderRadius: r,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 1 + off,
          width: s,
          height: s,
          background: "linear-gradient(140deg,#8f88ff,#59d8ff)",
          transform: "translateX(-50%) rotate(45deg)",
          borderRadius: r,
          boxShadow: glow ? "0 4px 12px rgba(110,102,255,0.4)" : undefined,
        }}
      />
    </div>
  );
}
