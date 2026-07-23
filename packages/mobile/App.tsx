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
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { NavigationContainer, DarkTheme } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";
import * as SecureStore from "expo-secure-store";
import { RelayClient } from "./src/api";
import { C } from "./src/theme";
import { kvGet, kvSet } from "./src/db";
import { fmtTok } from "./src/ui";
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
      {/* Top bar */}
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10, gap: 10 }}>
        <Text style={{ color: C.text, fontSize: 17, fontWeight: "600" }}>AgentDeck</Text>
        <Dot color={status === "ready" ? C.ok : status === "daemon-offline" ? C.warn : C.n600} />
        <View style={{ flex: 1 }} />
        {liveTotal > 0 && (
          <Text style={{ color: C.ok, fontSize: 12 }}>⚡ {fmtTok(liveTotal)} in flight</Text>
        )}
        <Pressable onPress={onLogout} hitSlop={10} style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}>
          <Text style={{ color: C.n600, fontSize: 12 }}>log out</Text>
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
        screenOptions={({ route }) => ({
          headerShown: false,
          // Lazy-mount tabs: cold start renders only Board + fires its one RPC,
          // instead of mounting all 6 screens and firing ~6 list fetches at
          // once. Each tab hydrates from the SQLite cache the moment it's first
          // opened, so lazy mount costs nothing visible. Global badges
          // (approvals, in-flight tokens) run at the App root off the event
          // stream, so they stay live without the screens being mounted.
          lazy: true,
          tabBarActiveTintColor: C.accent300,
          tabBarInactiveTintColor: C.n500,
          tabBarStyle: { backgroundColor: C.bg, borderTopColor: C.n800 },
          tabBarLabelStyle: { fontSize: 10.5 },
          tabBarIcon: ({ color, size }) => (
            <Ionicons name={TAB_ICON[route.name] ?? "ellipse-outline"} size={size - 4} color={color} />
          ),
        })}
      >
        <Tab.Screen name="Board" component={BoardTab} />
        <Tab.Screen name="Map" component={MapTab} />
        <Tab.Screen name="Runs" component={RunsTab} />
        <Tab.Screen
          name="Approvals"
          component={ApprovalsTab}
          options={approvalCount > 0 ? { tabBarBadge: approvalCount, tabBarBadgeStyle: { backgroundColor: C.accent, color: C.text, fontSize: 10 } } : {}}
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

  if (booting) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={{ flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center" }}>
          <StatusBar barStyle="light-content" />
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
              contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24, gap: 12 }}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={{ color: C.text, fontSize: 28, fontWeight: "600" }}>AgentDeck</Text>
              <Text style={{ color: C.n500, fontSize: 13, marginBottom: 8 }}>Sign in to your relay.</Text>
              <TextInput
                style={inputStyle}
                value={email}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="username"
                placeholder="email"
                placeholderTextColor={C.n600}
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
                placeholderTextColor={C.n600}
                onChangeText={setPassword}
                onSubmitEditing={doLogin}
              />
              {authError !== "" && <Text style={{ color: C.err, fontSize: 12 }}>{authError}</Text>}
              <Pressable
                onPress={doLogin}
                disabled={!email.trim() || !password || loggingIn}
                style={({ pressed }) => ({
                  backgroundColor: pressed ? C.accent700 : C.accent800,
                  borderColor: C.accent,
                  borderWidth: 1,
                  borderRadius: 10,
                  paddingVertical: 12,
                  alignItems: "center",
                  opacity: !email.trim() || !password || loggingIn ? 0.4 : 1,
                })}
              >
                <Text style={{ color: C.accent200, fontSize: 15, fontWeight: "600" }}>
                  {loggingIn ? "Signing in…" : "Sign in"}
                </Text>
              </Pressable>
              <TextInput
                style={[inputStyle, { fontSize: 12, marginTop: 8, color: C.n500 }]}
                value={url}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="relay url (advanced)"
                placeholderTextColor={C.n600}
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
  backgroundColor: C.surface,
  borderRadius: 10,
  borderWidth: 1,
  borderColor: C.n800,
  color: C.text,
  paddingHorizontal: 14,
  paddingVertical: 12,
  fontSize: 14,
} as const;
