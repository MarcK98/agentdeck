// AgentDeck design tokens (SPWN-39) — single source of colour + font families
// for the mobile app. Every screen reads from `C`, so a palette change here
// updates the whole app. Values mirror the `AgentDeck Mobile.dc.html` mockup.
export const C = {
  // ── Surfaces (deep → light) ──
  canvas: "#070812", // deepest layer / device backdrop / radial base
  bg: "#0b0c1a", // app screen background
  bgHeader: "#0e1023", // top bar tint
  inset: "#0e1023", // mono input blocks, textareas, code, pressed rows
  panel: "#101230", // section cards, bottom sheets, rails, popovers
  surface: "#14163a", // list cards (board/threads/runs/map), chip-bg
  card: "#14163a",
  selected: "#171a3e", // selected / team-lead card
  line: "#1b1e3d", // hairline dividers
  border: "#23264a", // default control border
  borderStrong: "#3d4179", // active border, sheet top edge
  sunken: "#2c3060", // logo back square, project dot

  // ── Text ──
  text: "#dfe1f5",
  muted: "#9ba0d4",
  dim: "#5c6094",

  // ── Brand / accents ──
  accent: "#8f88ff", // primary purple
  accent2: "#59d8ff", // cyan
  cyan: "#59d8ff",
  good: "#55e0a6",
  bad: "#ff7b8a",

  // ── Semantic status (legacy aliases, remapped to design tokens) ──
  ok: "#55e0a6",
  warn: "#ffc46b",
  err: "#ff7b8a",

  // ── Component borders ──
  warnBorder: "#6b5a35", // approval card
  cyanBorder: "#274b63", // token pill / cyan chip
  greenBorder: "#2a5d4d", // success card
  denyBorder: "#4b2a33", // deny button

  // ── Back-compat neutral ramp (legacy n* keys, remapped to nearest token) ──
  n300: "#9ba0d4",
  n400: "#9ba0d4",
  n500: "#5c6094",
  n600: "#5c6094",
  n700: "#3d4179",
  n800: "#23264a",
  n900: "#0e1023",

  // ── Back-compat accent tints (legacy accent* keys) ──
  accent200: "#b8b2ff",
  accent300: "#8f88ff",
  accent500: "#8f88ff",
  accent700: "#3d4179",
  accent800: "#171a3e",
} as const;

// Font families — loaded via useFonts in App.tsx (expo-google-fonts). Space
// Grotesk for UI, JetBrains Mono for labels/keys/metrics/code, matching the
// mockup. Google-fonts ship each weight as a distinct family name.
export const F = {
  ui: "SpaceGrotesk_400Regular",
  uiMed: "SpaceGrotesk_500Medium",
  uiBold: "SpaceGrotesk_700Bold",
  mono: "JetBrainsMono_400Regular",
  monoMed: "JetBrainsMono_500Medium",
  monoBold: "JetBrainsMono_700Bold",
} as const;
