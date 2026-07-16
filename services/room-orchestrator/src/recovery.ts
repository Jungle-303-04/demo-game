/**
 * The only mutations the Opsia integration may request. Values originate in a
 * reviewed deployment plan, never in game logs or player-controlled input.
 */
export type RecoveryRequest =
  | { action: "image_rollforward"; image: string }
  | { action: "image_rollback"; image: string }
  | { action: "deployment_scale"; replicas: number };

export interface WorkloadPatch {
  kind: "StatefulSet" | "Deployment";
  name: "game" | "api-server";
  patch: Record<string, unknown>;
}

export const recoveryPatch = (request: RecoveryRequest): WorkloadPatch => {
  if (request.action === "deployment_scale") {
    if (!Number.isInteger(request.replicas) || request.replicas < 1 || request.replicas > 100) throw new Error("invalid_replicas");
    return { kind: "Deployment", name: "api-server", patch: { spec: { replicas: request.replicas } } };
  }
  if (!/^ghcr\.io\/jungle-303-04\/demo-game\/game-server:[a-zA-Z0-9._-]+$/.test(request.image)) throw new Error("unapproved_image");
  return { kind: "StatefulSet", name: "game", patch: { spec: { template: { spec: { containers: [{ name: "game-server", image: request.image }] } } } } };
};
