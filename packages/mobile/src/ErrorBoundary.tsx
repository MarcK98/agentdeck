// Top-level error boundary. A render-time throw anywhere below the root would
// otherwise unmount the whole tree — a redbox in dev, but a silent black screen
// in a release/Hermes build. This catches it and shows the message + stack so a
// startup crash is diagnosable from the device instead of an unexplained void.

import React from "react";
import { ScrollView, Text, View } from "react-native";
import { C } from "./theme";

interface Props {
  children: React.ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Surfaces in the device/Xcode log even in a release build.
    console.log("[AgentDeck] fatal render error:", error?.message, error?.stack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: 80, paddingHorizontal: 20 }}>
        <Text style={{ color: C.err, fontSize: 18, fontWeight: "600", marginBottom: 10 }}>
          AgentDeck hit a startup error
        </Text>
        <Text style={{ color: C.n400, fontSize: 13, marginBottom: 16 }}>
          Something threw before the app could render. Details below — please send this to support.
        </Text>
        <ScrollView style={{ flex: 1 }}>
          <Text style={{ color: C.text, fontSize: 13, fontWeight: "600", marginBottom: 6 }}>
            {error.message || String(error)}
          </Text>
          {!!error.stack && (
            <Text style={{ color: C.n500, fontSize: 11, fontFamily: "Menlo" }}>{error.stack}</Text>
          )}
        </ScrollView>
      </View>
    );
  }
}
