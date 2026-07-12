//! TanStack Query hooks over the API client. Pools are short-lived (odds + status
//! change as deposits land and rounds advance), so reads poll on a modest interval.

import { useQuery } from "@tanstack/react-query";

import { api } from "./client.js";
import type { Hex, PoolStatus } from "./types.js";

const POLL_MS = 10_000;

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 15_000,
    retry: false,
  });
}

export function useLanes() {
  return useQuery({ queryKey: ["lanes"], queryFn: api.lanes, refetchInterval: POLL_MS });
}

export function usePools(filter?: { status?: PoolStatus | number; lane?: string }) {
  return useQuery({
    queryKey: ["pools", filter ?? null],
    queryFn: () => api.pools(filter),
    refetchInterval: POLL_MS,
  });
}

export function usePool(poolId: Hex | undefined) {
  return useQuery({
    queryKey: ["pool", poolId],
    queryFn: () => api.pool(poolId!),
    enabled: Boolean(poolId),
    refetchInterval: POLL_MS,
  });
}

export function usePositions(lock: Hex | undefined) {
  return useQuery({
    queryKey: ["positions", lock],
    queryFn: () => api.positions(lock!),
    enabled: Boolean(lock),
    refetchInterval: POLL_MS,
  });
}

export function useHistory(lane?: string) {
  return useQuery({ queryKey: ["history", lane ?? null], queryFn: () => api.history(lane) });
}
