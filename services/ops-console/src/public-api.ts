const PUBLIC_CONTROL_PLANE_READS = new Set([
  "/api/admin/rooms",
  "/api/admin/events",
]);

export function isPublicControlPlaneRead(method: string | undefined, pathname: string): boolean {
  return method === "GET" && PUBLIC_CONTROL_PLANE_READS.has(pathname);
}
