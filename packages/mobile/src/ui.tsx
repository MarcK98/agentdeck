// Shared UI bits — every touchable gives pressed feedback (opacity + subtle
// background) and a selection haptic, the Discord-feel baseline. Styling follows
// the AgentDeck mockup: JetBrains-Mono labels/pills, Space-Grotesk UI text.

import React, { useEffect, useRef } from "react";
import { ActivityIndicator, Animated, Pressable, Text, View, ViewStyle, StyleProp } from "react-native";
import * as Haptics from "expo-haptics";
import { C, F } from "./theme";

export const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

// Bottom clearance so scroll content clears the floating tab-bar pill.
export const TAB_SPACE = 96;

export const tapHaptic = () => Haptics.selectionAsync().catch(() => {});
export const actionHaptic = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});

export const S = {
  card: {
    backgroundColor: C.surface,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: C.border,
    padding: 12,
    marginBottom: 8,
  },
  title: { color: C.text, fontSize: 14, fontWeight: "500" as const, fontFamily: F.uiMed },
  dim: { color: C.dim, fontSize: 12, fontFamily: F.ui },
  // Section caption: mono, uppercase, dim — mirrors the mockup's `letter-spacing`
  // labels above every group.
  cap: {
    color: C.dim,
    fontSize: 10.5,
    fontFamily: F.monoMed,
    letterSpacing: 1.1,
    textTransform: "uppercase" as const,
  },
  // Inline mono tag (model chips on threads/settings).
  tag: {
    color: C.muted,
    fontSize: 10,
    fontFamily: F.monoMed,
    backgroundColor: C.panel,
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    overflow: "hidden" as const,
  },
};

// Card-shaped pressable: darkens while pressed, haptic on press-in.
export function Card({
  onPress,
  style,
  children,
}: {
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  if (!onPress) return <View style={[S.card, style]}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      onPressIn={tapHaptic}
      style={({ pressed }) => [
        S.card,
        style,
        pressed && { backgroundColor: C.inset, transform: [{ scale: 0.985 }] },
      ]}
    >
      {children}
    </Pressable>
  );
}

// Button. `fill` renders a solid brand-purple CTA with dark text (the mockup's
// gradient primary, flattened — no LinearGradient dep). Default is the outline
// style keyed on `color` (green Allow, red Deny, muted secondary…).
export function Btn({
  label,
  color,
  onPress,
  disabled,
  busy,
  fill,
}: {
  label: string;
  color: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  fill?: boolean;
}) {
  const dark = "#0b0c1a";
  return (
    <Pressable
      onPress={() => {
        actionHaptic();
        onPress();
      }}
      disabled={disabled || busy}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        borderColor: color,
        borderWidth: fill ? 0 : 1,
        borderRadius: 9,
        paddingHorizontal: 16,
        paddingVertical: 9,
        opacity: disabled && !busy ? 0.4 : 1,
        backgroundColor: fill
          ? pressed
            ? `${color}cc`
            : color
          : pressed
          ? `${color}22`
          : "transparent",
      })}
    >
      {busy && <ActivityIndicator size="small" color={fill ? dark : color} />}
      <Text style={{ color: fill ? dark : color, fontSize: 13, fontWeight: "700", fontFamily: F.uiBold }}>
        {label}
      </Text>
    </Pressable>
  );
}

// Pill chip (model/effort/status/range). Selected = cyan border + cyan text +
// tinted bg, per the mockup.
export function Chip({ label, on, onPress, dim }: { label: string; on: boolean; onPress: () => void; dim?: boolean }) {
  return (
    <Pressable
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      style={({ pressed }) => ({
        borderWidth: 1,
        borderColor: on ? C.cyan : C.border,
        backgroundColor: pressed ? C.card : on ? "rgba(89,216,255,0.10)" : "transparent",
        borderRadius: 100,
        paddingHorizontal: 12,
        paddingVertical: 6,
        opacity: dim ? 0.4 : 1,
      })}
    >
      <Text style={{ color: on ? C.cyan : C.muted, fontSize: 11, fontFamily: F.monoMed }}>{label}</Text>
    </Pressable>
  );
}

// Status dot. `pulse` runs the mockup's `adPulse` (opacity 1↔0.3) for running.
export function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  const op = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!pulse) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(op, { toValue: 0.3, duration: 750, useNativeDriver: true }),
        Animated.timing(op, { toValue: 1, duration: 750, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, op]);
  return (
    <Animated.View
      style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, opacity: pulse ? op : 1 }}
    />
  );
}

export function Center({ text, spinner }: { text?: string; spinner?: boolean }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 40 }}>
      {spinner ? <ActivityIndicator color={C.accent} /> : <Text style={S.dim}>{text}</Text>}
    </View>
  );
}

// Per-screen fetch-failure strip with a retry — failures must look different
// from "empty".
export function ErrorBar({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        margin: 14,
        padding: 10,
        borderRadius: 9,
        borderWidth: 1,
        borderColor: C.bad,
        backgroundColor: `${C.bad}18`,
      }}
    >
      <Text style={{ color: C.bad, fontSize: 12, flex: 1, fontFamily: F.ui }}>{message}</Text>
      <Btn label="Retry" color={C.bad} onPress={onRetry} />
    </View>
  );
}

// Form group with a mono uppercase caption (mockup style).
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={S.cap}>{label}</Text>
      {children}
    </View>
  );
}
