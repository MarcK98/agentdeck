import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, ScrollView, StatusBar, Text, TextInput, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import { RelayClient } from "./src/api";
import { C } from "./src/theme";

// The deployed relay (override in the login screen if you self-host). The phone
// signs in with email + password → the relay returns a JWT it then connects with.
const DEFAULT_WS = "wss://spawn-relay.duckdns.org";
const TOKEN_KEY = "spawn.token";
const URL_KEY = "spawn.relay";
const httpFrom = (ws: string) => ws.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
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

// Spawn mobile — a relay client of the local daemon. The login screen posts
// email + password to the relay's /auth/login, stores the returned JWT in the
// device keychain (expo-secure-store), and connects the RelayClient with it.

type Tab = "board" | "map" | "runs" | "approvals" | "usage" | "settings";

export default function App() {
  const [conn, setConn] = useState<{ url: string; token: string } | null>(null);
  const [booting, setBooting] = useState(true);
  // Login form.
  const [url, setUrl] = useState(DEFAULT_WS);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [authError, setAuthError] = useState("");
  const [status, setStatus] = useState<string>("disconnected");
  const [tab, setTab] = useState<Tab>("board");
  const [thread, setThread] = useState<{ id: number; title: string } | null>(null);
  const [projects, setProjects] = useState<any[]>([]);
  const [approvalCount, setApprovalCount] = useState(0);
  const [liveTotal, setLiveTotal] = useState(0);
  const liveMap = useRef(new Map<number, number>());

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
    });
    const offEvents = client.onEvent((ev) => {
      if (ev.type === "approval:request") setApprovalCount((n) => n + 1);
      if (ev.type === "approval:resolved") setApprovalCount((n) => Math.max(0, n - 1));
      if (ev.type === "turn:usage") {
        liveMap.current.set(ev.payload.threadId, ev.payload.liveTokens);
        setLiveTotal([...liveMap.current.values()].reduce((a, b) => a + b, 0));
      }
      if (ev.type === "turn:done") {
        liveMap.current.delete(ev.payload.threadId);
        setLiveTotal([...liveMap.current.values()].reduce((a, b) => a + b, 0));
      }
    });
    client.rpc<any[]>("listApprovals").then((a) => setApprovalCount(a.length)).catch(() => {});
    client.rpc<any[]>("listProjects").then(setProjects).catch(() => {});
    return () => {
      offStatus();
      offEvents();
      client.close();
    };
  }, [client]);

  if (booting) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center" }}>
        <StatusBar barStyle="light-content" />
        <ActivityIndicator color={C.accent} />
      </SafeAreaView>
    );
  }

  if (!client) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <StatusBar barStyle="light-content" />
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <ScrollView
            contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24, gap: 12 }}
            keyboardShouldPersistTaps="handled"
          >
          <Text style={{ color: C.text, fontSize: 28, fontWeight: "600" }}>Spawn</Text>
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
            style={{
              backgroundColor: C.accent800,
              borderColor: C.accent,
              borderWidth: 1,
              borderRadius: 10,
              paddingVertical: 12,
              alignItems: "center",
              opacity: !email.trim() || !password || loggingIn ? 0.4 : 1,
            }}
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
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar barStyle="light-content" />
      {/* Top bar */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingVertical: 10,
          gap: 10,
        }}
      >
        <Text style={{ color: C.text, fontSize: 17, fontWeight: "600" }}>Spawn</Text>
        <Dot color={status === "ready" ? C.ok : status === "daemon-offline" ? C.warn : C.n600} />
        <Text style={{ color: C.n600, fontSize: 11 }}>{status}</Text>
        <View style={{ flex: 1 }} />
        {liveTotal > 0 && (
          <Text style={{ color: C.ok, fontSize: 12 }}>
            ⚡ {liveTotal >= 1e6 ? `${(liveTotal / 1e6).toFixed(1)}M` : `${Math.round(liveTotal / 1e3)}k`} in flight
          </Text>
        )}
        <Pressable onPress={doLogout} hitSlop={10}>
          <Text style={{ color: C.n600, fontSize: 12 }}>log out</Text>
        </Pressable>
      </View>

      {/* Content */}
      <View style={{ flex: 1 }}>
        {thread ? (
          <ThreadScreen
            client={client}
            threadId={thread.id}
            title={thread.title}
            onBack={() => setThread(null)}
          />
        ) : tab === "board" ? (
          <BoardScreen client={client} projects={projects} openThread={(id, title) => setThread({ id, title })} />
        ) : tab === "map" ? (
          <MapScreen client={client} openThread={(id, title) => setThread({ id, title })} />
        ) : tab === "approvals" ? (
          <ApprovalsScreen client={client} />
        ) : tab === "usage" ? (
          <UsageScreen client={client} />
        ) : tab === "settings" ? (
          <SettingsScreen client={client} projects={projects} />
        ) : (
          <RunsScreen client={client} openThread={(id, title) => setThread({ id, title })} />
        )}
      </View>

      {/* Tabs */}
      {!thread && (
        <View
          style={{
            flexDirection: "row",
            borderTopWidth: 1,
            borderTopColor: C.n800,
            paddingVertical: 8,
            paddingBottom: 4,
          }}
        >
          {(
            [
              ["board", "Board"],
              ["map", "Map"],
              ["runs", "Runs"],
              ["approvals", approvalCount ? `Appr·${approvalCount}` : "Appr"],
              ["usage", "Usage"],
              ["settings", "Settings"],
            ] as [Tab, string][]
          ).map(([key, label]) => (
            <Pressable key={key} style={{ flex: 1, alignItems: "center", paddingVertical: 8, paddingHorizontal: 2 }} onPress={() => setTab(key)}>
              <Text
                numberOfLines={1}
                style={{
                  color: tab === key ? C.accent300 : C.n500,
                  fontSize: 12,
                  fontWeight: tab === key ? "600" : "400",
                }}
              >
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </SafeAreaView>
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
