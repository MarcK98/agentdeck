import { registerRootComponent } from "expo";
import React from "react";
import { ScrollView, Text, View } from "react-native";

// SPWN-31 diagnostic root: a release/Hermes build shows a black screen when a
// module throws at import time — before React renders — so nothing (not even an
// ErrorBoundary) catches it. Lazy-require ./App inside a try/catch and paint the
// error to the device so the startup crash is visible instead of a void.
function FatalScreen({ err }: { err: any }) {
  const msg = (err && (err.message || err.toString())) || "unknown error";
  const stack = (err && err.stack) || "";
  return React.createElement(
    View,
    { style: { flex: 1, backgroundColor: "#161826", paddingTop: 80, paddingHorizontal: 20 } },
    React.createElement(
      Text,
      { style: { color: "#d96a5f", fontSize: 18, fontWeight: "600", marginBottom: 10 } },
      "AgentDeck startup error"
    ),
    React.createElement(
      ScrollView,
      { style: { flex: 1 } },
      React.createElement(
        Text,
        { selectable: true, style: { color: "#e9e9ed", fontSize: 13, fontWeight: "600", marginBottom: 8 } },
        String(msg)
      ),
      React.createElement(
        Text,
        { selectable: true, style: { color: "#9397ab", fontSize: 11, fontFamily: "Menlo" } },
        String(stack)
      )
    )
  );
}

let Root: React.ComponentType;
try {
  const App = require("./App").default;
  const { ErrorBoundary } = require("./src/ErrorBoundary");
  Root = function DiagRoot() {
    return React.createElement(ErrorBoundary, null, React.createElement(App, null));
  };
} catch (e) {
  Root = function DiagRoot() {
    return React.createElement(FatalScreen, { err: e });
  };
}

registerRootComponent(Root);
