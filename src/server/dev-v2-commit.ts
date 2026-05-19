import type { EffectTranscript } from "../core/effect-transcript";
import { transcriptSessionActiveScope, transcriptTouchedObjectIds } from "../core/shadow-commit-scope";
import type { ObjRef } from "../core/types";
import type { WooWorld } from "../core/world";

const DEV_WORLD_HOST = "world";

export type DevV2LocalCommitMaterialization = {
  hosts: string[];
};

export function materializeDevV2CommitLocally(
  world: WooWorld,
  scope: ObjRef,
  transcript: EffectTranscript
): DevV2LocalCommitMaterialization {
  const hosts = devV2LocalCommitHosts(world, scope, transcript);
  for (const host of hosts) {
    world.applyCommittedShadowTranscriptToHost(host, transcript, { gatewayHost: host === DEV_WORLD_HOST });
  }
  return { hosts };
}

export function devV2LocalCommitHosts(world: WooWorld, scope: ObjRef, transcript: EffectTranscript): string[] {
  const routeHost = new Map(world.objectRoutes().map((route) => [route.id, route.host] as const));
  const createdIds = new Set(transcript.creates.map((create) => create.object));
  const hosts = new Set<string>();
  const addHostFor = (id: ObjRef | null | undefined): void => {
    if (!id) return;
    hosts.add(routeHost.get(id) ?? DEV_WORLD_HOST);
  };

  addHostFor(scope);
  for (const id of transcriptTouchedObjectIds(transcript)) {
    if (!createdIds.has(id)) addHostFor(id);
  }
  for (const create of transcript.creates) {
    const host =
      routeHost.get(create.object) ??
      (create.anchor ? routeHost.get(create.anchor) : undefined) ??
      (create.location ? routeHost.get(create.location) : undefined) ??
      DEV_WORLD_HOST;
    hosts.add(host);
  }
  if (transcriptSessionActiveScope(transcript)) hosts.add(DEV_WORLD_HOST);
  return Array.from(hosts).sort();
}
