import { useCallback, useEffect, useRef, useState } from "react";
import { RelayClient, SpawnEvent } from "./api";
import { kvGet, kvSet } from "./db";

export function useSpawnEvents(client: RelayClient, types: string[], cb: (ev: SpawnEvent) => void) {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(
    () => client.onEvent((ev) => {
      if (types.includes(ev.type)) cbRef.current(ev);
    }),
    [client] // eslint-disable-line react-hooks/exhaustive-deps
  );
}

// Run cb every time the relay reports ready — screens use it to reconcile
// after a reconnect (events missed during the drop are otherwise lost).
export function useOnReady(client: RelayClient, cb: () => void) {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(
    () => client.onStatus((st) => {
      if (st === "ready") cbRef.current();
    }),
    [client]
  );
}

// A single global turn:start / turn:done fans out to every list screen (Board,
// Map, Runs all refetch on turn events). With several agents running that's a
// burst of identical RPCs many times a second. Coalesce them: fire once on the
// leading edge, then at most one trailing refetch per window, so a storm of
// events costs one or two RPCs instead of dozens.
const REFRESH_WINDOW_MS = 400;

// Cache-first fetch: hydrate synchronously from SQLite, fetch live, write
// through, refetch whenever the relay (re)connects. `error` is set only when
// the fetch fails AND nothing is cached — stale data beats an error screen.
export function useCachedRpc<T>(client: RelayClient, cacheKey: string, method: string, ...args: any[]) {
  const [data, setData] = useState<T | null>(() => kvGet<T>(cacheKey));
  const [stale, setStale] = useState(true);
  const [error, setError] = useState("");
  const argsKey = JSON.stringify(args);

  const doFetch = useCallback(() => {
    client
      .rpc<T>(method, ...(JSON.parse(argsKey) as any[]))
      .then((v) => {
        setData(v);
        setStale(false);
        setError("");
        kvSet(cacheKey, v);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [client, cacheKey, method, argsKey]);

  // Throttle wrapper around the latest doFetch. `refresh` itself is stable so
  // event subscriptions never re-bind; it always calls the current fetch.
  const doFetchRef = useRef(doFetch);
  doFetchRef.current = doFetch;
  const cooling = useRef(false);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    if (cooling.current) {
      pending.current = true;
      return;
    }
    cooling.current = true;
    doFetchRef.current();
    const tick = () => {
      if (pending.current) {
        pending.current = false;
        doFetchRef.current();
        timer.current = setTimeout(tick, REFRESH_WINDOW_MS);
      } else {
        cooling.current = false;
        timer.current = null;
      }
    };
    timer.current = setTimeout(tick, REFRESH_WINDOW_MS);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  useEffect(() => {
    setData(kvGet<T>(cacheKey));
    setStale(true);
    refresh();
  }, [refresh, cacheKey, argsKey]);
  useOnReady(client, refresh);

  return { data, stale, error: data == null ? error : "", refresh, setData };
}
