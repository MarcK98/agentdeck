import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  Text,
  TextInput,
  View,
  ViewStyle,
} from "react-native";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { NavigationContainer, DarkTheme } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";
import * as SecureStore from "expo-secure-store";
import {
  useFonts,
  SpaceGrotesk_400Regular,
  SpaceGrotesk_500Medium,
  SpaceGrotesk_700Bold,
} from "@expo-google-fonts/space-grotesk";
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_700Bold,
} from "@expo-google-fonts/jetbrains-mono";
import { RelayClient } from "./src/api";
import { C, F } from "./src/theme";
import { kvGet, kvSet } from "./src/db";
import { fmtTok, tapHaptic } from "./src/ui";
import {
  ApprovalsScreen,
  BoardScreen,
  Dot,
  MapScreen,
  RunsScreen,
  SettingsScreen,
  ThreadScreen,
  UsageScreen,
} from "./src/screens";

// The deployed relay (override in the login screen if you self-host). The phone
// signs in with email + password → the relay returns a JWT it then connects with.
const DEFAULT_WS = "wss://spawn-relay.duckdns.org";
const TOKEN_KEY = "spawn.token";
const URL_KEY = "spawn.relay";
const httpFrom = (ws: string) => ws.replace(/^wss:/, "https:").replace(/^ws:/, "http:");

// AgentDeck mobile — a relay client of the local daemon. Discord-shaped shell:
// bottom tabs + a pushed thread screen (swipe back, hardware back), every
// list SQLite-cached for instant cold start.

interface Ctx {
  client: RelayClient;
  projects: any[];
  status: string;
}
const AgentDeckCtx = createContext<Ctx>(null as any);
const useAgentDeck = () => useContext(AgentDeckCtx);

type StackParams = {
  Tabs: undefined;
  Thread: { id: number; title: string };
};

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator<StackParams>();

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: C.bg,
    card: C.bg,
    border: C.n800,
    primary: C.accent300,
    text: C.text,
  },
};

const openThreadFrom = (navigation: any) => (id: number, title: string) =>
  navigation.navigate("Thread", { id, title });

function BoardTab({ navigation }: any) {
  const { client, projects } = useAgentDeck();
  return <BoardScreen client={client} projects={projects} openThread={openThreadFrom(navigation)} />;
}
function MapTab({ navigation }: any) {
  const { client } = useAgentDeck();
  return <MapScreen client={client} openThread={openThreadFrom(navigation)} />;
}
function RunsTab({ navigation }: any) {
  const { client } = useAgentDeck();
  return <RunsScreen client={client} openThread={openThreadFrom(navigation)} />;
}
function ApprovalsTab() {
  const { client } = useAgentDeck();
  return <ApprovalsScreen client={client} />;
}
function UsageTab() {
  const { client } = useAgentDeck();
  return <UsageScreen client={client} />;
}
function SettingsTab() {
  const { client, projects } = useAgentDeck();
  return <SettingsScreen client={client} projects={projects} />;
}

const TAB_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  Board: "albums-outline",
  Map: "git-network-outline",
  Runs: "pulse-outline",
  Approvals: "hand-left-outline",
  Usage: "stats-chart-outline",
  Settings: "settings-outline",
};

// Diamond logo mark — two 45°-rotated rounded squares: sunken back + brand front
// (gradient flattened to accent purple, no LinearGradient dep).
function Logo({ scale = 1 }: { scale?: number }) {
  const w = 19 * scale;
  const h = 21 * scale;
  const sq = 11 * scale;
  const r = 2.5 * scale;
  const box = (top: number, bg: string, extra?: object): ViewStyle => ({
    position: "absolute",
    left: "50%",
    top: top * scale,
    marginLeft: -sq / 2,
    width: sq,
    height: sq,
    backgroundColor: bg,
    borderRadius: r,
    transform: [{ rotate: "45deg" }],
    ...extra,
  });
  return (
    <View style={{ width: w, height: h }}>
      <View style={box(1, C.sunken)} />
      <View
        style={box(6.5, C.accent, {
          shadowColor: C.accent,
          shadowOpacity: 0.45,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 4 },
        })}
      />
    </View>
  );
}

// Floating rounded pill tab bar — translucent panel, icon + label per tab,
// tinted active tab, purple approval badge. Matches the mockup's bottom bar.
function FloatingTabBar({ state, descriptors, navigation }: any) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        position: "absolute",
        left: 10,
        right: 10,
        bottom: Math.max(insets.bottom, 12),
        flexDirection: "row",
        backgroundColor: "rgba(16,18,48,0.92)",
        borderWidth: 1,
        borderColor: C.border,
        borderRadius: 18,
        padding: 6,
      }}
    >
      {state.routes.map((route: any, index: number) => {
        const { options } = descriptors[route.key];
        const focused = state.index === index;
        const label = (options.title ?? route.name) as string;
        const badge = options.tabBarBadge;
        const color = focused ? C.accent : C.dim;
        const onPress = () => {
          tapHaptic();
          const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
        };
        return (
          <Pressable
            key={route.key}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityState={focused ? { selected: true } : {}}
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              gap: 3,
              paddingVertical: 7,
              borderRadius: 13,
              backgroundColor: focused ? "rgba(143,136,255,0.14)" : "transparent",
            }}
          >
            <View>
              <Ionicons name={TAB_ICON[route.name] ?? "ellipse-outline"} size={18} color={color} />
              {badge != null && (
                <View
                  style={{
                    position: "absolute",
                    top: -5,
                    right: -10,
                    minWidth: 15,
                    height: 15,
                    borderRadius: 100,
                    paddingHorizontal: 3,
                    backgroundColor: C.accent,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ color: "#0b0c1a", fontSize: 8.5, fontWeight: "700", fontFamily: F.monoBold }}>
                    {badge}
                  </Text>
                </View>
              )}
            </View>
            <Text style={{ color, fontSize: 9, fontWeight: "500", fontFamily: F.ui }}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Tabs({
  approvalCount,
  liveTotal,
  status,
  onLogout,
}: {
  approvalCount: number;
  liveTotal: number;
  status: string;
  onLogout: () => void;
}) {
  return (
    <View style={{ flex: 1 }}>
      {/* Top bar — diamond logo, wordmark, status dot, cyan token pill, log out. */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingTop: 6,
          paddingBottom: 12,
          gap: 9,
          borderBottomWidth: 1,
          borderBottomColor: C.line,
        }}
      >
        <Logo />
        <Text style={{ color: C.text, fontSize: 16, fontWeight: "700", fontFamily: F.uiBold, letterSpacing: -0.2 }}>
          AgentDeck
        </Text>
        <Dot color={status === "ready" ? C.good : status === "daemon-offline" ? C.warn : C.dim} />
        <View style={{ flex: 1 }} />
        {liveTotal > 0 && (
          <Text
            style={{
              color: C.cyan,
              fontFamily: F.monoMed,
              fontSize: 10.5,
              borderWidth: 1,
              borderColor: C.cyanBorder,
              borderRadius: 100,
              paddingHorizontal: 11,
              paddingVertical: 5,
              overflow: "hidden",
            }}
          >
            ▲ {fmtTok(liveTotal)}
          </Text>
        )}
        <Pressable onPress={onLogout} hitSlop={10} style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}>
          <Text style={{ color: C.dim, fontSize: 12, fontFamily: F.ui }}>log out</Text>
        </Pressable>
      </View>
      {/* Reconnect banner — Discord-style strip while the socket is down. */}
      {status !== "ready" && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            marginHorizontal: 12,
            marginBottom: 6,
            paddingHorizontal: 12,
            paddingVertical: 7,
            borderRadius: 8,
            backgroundColor: status === "daemon-offline" ? `${C.warn}22` : `${C.err}18`,
          }}
        >
          <ActivityIndicator size="small" color={status === "daemon-offline" ? C.warn : C.err} />
          <Text style={{ color: status === "daemon-offline" ? C.warn : C.err, fontSize: 12 }}>
            {status === "daemon-offline"
              ? "Relay reached — daemon offline. Showing last-known data."
              : "Reconnecting… showing last-known data."}
          </Text>
        </View>
      )}
      <Tab.Navigator
        tabBar={(props) => <FloatingTabBar {...props} />}
        screenOptions={{
          headerShown: false,
          // Lazy-mount tabs: cold start renders only Board + fires its one RPC,
          // instead of mounting all 6 screens and firing ~6 list fetches at
          // once. Each tab hydrates from the SQLite cache the moment it's first
          // opened, so lazy mount costs nothing visible. Global badges
          // (approvals, in-flight tokens) run at the App root off the event
          // stream, so they stay live without the screens being mounted.
          lazy: true,
        }}
      >
        <Tab.Screen name="Board" component={BoardTab} />
        <Tab.Screen name="Map" component={MapTab} />
        <Tab.Screen name="Runs" component={RunsTab} />
        <Tab.Screen
          name="Approvals"
          component={ApprovalsTab}
          options={approvalCount > 0 ? { tabBarBadge: approvalCount } : {}}
        />
        <Tab.Screen name="Usage" component={UsageTab} />
        <Tab.Screen name="Settings" component={SettingsTab} />
      </Tab.Navigator>
    </View>
  );
}

function ThreadRoute({ route, navigation }: any) {
  const { client } = useAgentDeck();
  return (
    <ThreadScreen
      client={client}
      threadId={route.params.id}
      title={route.params.title}
      onBack={() => navigation.goBack()}
    />
  );
}

export default function App() {
  const [conn, setConn] = useState<{ url: string; token: string } | null>(null);
  const [booting, setBooting] = useState(true);
  // Login form.
  const [url, setUrl] = useState(DEFAULT_WS);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [authError, setAuthError] = useState("");
  const [status, setStatus] = useState<string>("connecting");
  const [projects, setProjects] = useState<any[]>(() => kvGet("projects") ?? []);
  const [approvalCount, setApprovalCount] = useState(0);
  const [liveTotal, setLiveTotal] = useState(0);
  const liveMap = useRef(new Map<number, number>());
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Space Grotesk (UI) + JetBrains Mono (labels/metrics) from the design. Gate
  // the app behind the load so text never flashes in the system font first.
  const [fontsLoaded] = useFonts({
    SpaceGrotesk_400Regular,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_700Bold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
    JetBrainsMono_700Bold,
  });

  const client = useMemo(() => (conn ? new RelayClient(conn.url, conn.token) : null), [conn]);

  // Resume a saved session on launch.
  useEffect(() => {
    (async () => {
      try {
        const t = await SecureStore.getItemAsync(TOKEN_KEY);
        const savedUrl = (await SecureStore.getItemAsync(URL_KEY)) || DEFAULT_WS;
        if (t) {
          setUrl(savedUrl);
          setConn({ url: savedUrl, token: t });
        }
      } catch {
        /* no stored session */
      }
      setBooting(false);
    })();
  }, []);

  const doLogin = async () => {
    const em = email.trim().toLowerCase();
    if (!em || !password || loggingIn) return;
    setLoggingIn(true);
    setAuthError("");
    try {
      const res = await fetch(`${httpFrom(url)}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: em, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token) {
        setAuthError(data.error || `login failed (${res.status})`);
        return;
      }
      await SecureStore.setItemAsync(TOKEN_KEY, data.token);
      await SecureStore.setItemAsync(URL_KEY, url);
      setPassword("");
      setConn({ url, token: data.token });
    } catch {
      setAuthError("Can't reach the relay — check the URL and your connection.");
    } finally {
      setLoggingIn(false);
    }
  };

  const doLogout = () => {
    SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
    setConn(null);
  };

  useEffect(() => {
    if (!client) return;
    client.connect();
    const offStatus = client.onStatus((st) => {
      setStatus(st);
      if (st === "unauthorized") {
        SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
        setConn(null);
        setAuthError("Session expired — sign in again.");
      }
      if (st === "ready") {
        client.rpc<any[]>("listApprovals").then((a) => setApprovalCount(a.length)).catch(() => {});
        client
          .rpc<any[]>("listProjects")
          .then((p) => {
            setProjects(p);
            kvSet("projects", p);
          })
          .catch(() => {});
      }
    });
    const offEvents = client.onEvent((ev) => {
      if (ev.type === "approval:request") setApprovalCount((n) => n + 1);
      if (ev.type === "approval:resolved") setApprovalCount((n) => Math.max(0, n - 1));
      if (ev.type === "turn:usage" || ev.type === "turn:done") {
        if (ev.type === "turn:usage") liveMap.current.set(ev.payload.threadId, ev.payload.liveTokens);
        else liveMap.current.delete(ev.payload.threadId);
        // Throttle: per-token events would re-render the app root constantly.
        if (!liveTimer.current) {
          liveTimer.current = setTimeout(() => {
            liveTimer.current = null;
            setLiveTotal([...liveMap.current.values()].reduce((a, b) => a + b, 0));
          }, 500);
        }
      }
    });
    // The outbox in RelayClient holds these until the socket opens.
    client.rpc<any[]>("listApprovals").then((a) => setApprovalCount(a.length)).catch(() => {});
    client
      .rpc<any[]>("listProjects")
      .then((p) => {
        setProjects(p);
        kvSet("projects", p);
      })
      .catch(() => {});
    return () => {
      offStatus();
      offEvents();
      if (liveTimer.current) clearTimeout(liveTimer.current);
      client.close();
    };
  }, [client]);

  if (booting || !fontsLoaded) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={{ flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center", gap: 22 }}>
          <StatusBar barStyle="light-content" />
          <Logo scale={1.7} />
          <ActivityIndicator color={C.accent} />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  if (!client) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
          <StatusBar barStyle="light-content" />
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
            <ScrollView
              contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 28, gap: 12 }}
              keyboardShouldPersistTaps="handled"
            >
              <View style={{ alignItems: "center", gap: 13, marginBottom: 14 }}>
                <Logo scale={1.8} />
                <Text
                  style={{ color: C.text, fontSize: 23, fontWeight: "700", fontFamily: F.uiBold, letterSpacing: -0.4 }}
                >
                  Connect to your deck
                </Text>
                <Text
                  style={{
                    color: C.muted,
                    fontSize: 13,
                    fontFamily: F.ui,
                    lineHeight: 20,
                    textAlign: "center",
                    maxWidth: 280,
                  }}
                >
                  Sign in to your relay — the phone pairs with the daemon running on your desktop.
                </Text>
              </View>
              <TextInput
                style={inputStyle}
                value={email}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="username"
                placeholder="email"
                placeholderTextColor={C.dim}
                onChangeText={setEmail}
              />
              <TextInput
                style={inputStyle}
                value={password}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                textContentType="password"
                placeholder="password"
                placeholderTextColor={C.dim}
                onChangeText={setPassword}
                onSubmitEditing={doLogin}
              />
              {authError !== "" && <Text style={{ color: C.bad, fontSize: 12, fontFamily: F.ui }}>{authError}</Text>}
              <Pressable
                onPress={doLogin}
                disabled={!email.trim() || !password || loggingIn}
                style={({ pressed }) => ({
                  backgroundColor: pressed ? `${C.accent}cc` : C.accent,
                  borderRadius: 11,
                  paddingVertical: 14,
                  alignItems: "center",
                  opacity: !email.trim() || !password || loggingIn ? 0.4 : 1,
                })}
              >
                <Text style={{ color: "#0b0c1a", fontSize: 15, fontWeight: "700", fontFamily: F.uiBold }}>
                  {loggingIn ? "Connecting…" : "Sign in"}
                </Text>
              </Pressable>
              <TextInput
                style={[inputStyle, { fontSize: 12, marginTop: 8, color: C.dim, fontFamily: F.mono }]}
                value={url}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="relay url (advanced)"
                placeholderTextColor={C.dim}
                onChangeText={setUrl}
              />
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AgentDeckCtx.Provider value={{ client, projects, status }}>
          <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={["top"]}>
            <StatusBar barStyle="light-content" />
            <NavigationContainer theme={navTheme}>
              <Stack.Navigator screenOptions={{ headerShown: false, animation: "slide_from_right" }}>
                <Stack.Screen name="Tabs">
                  {() => (
                    <Tabs approvalCount={approvalCount} liveTotal={liveTotal} status={status} onLogout={doLogout} />
                  )}
                </Stack.Screen>
                <Stack.Screen name="Thread" component={ThreadRoute} />
              </Stack.Navigator>
            </NavigationContainer>
          </SafeAreaView>
        </AgentDeckCtx.Provider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const inputStyle = {
  backgroundColor: C.panel,
  borderRadius: 11,
  borderWidth: 1,
  borderColor: C.border,
  color: C.text,
  fontFamily: F.ui,
  paddingHorizontal: 14,
  paddingVertical: 13,
  fontSize: 14,
} as const;
