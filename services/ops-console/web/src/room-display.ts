const KUBERNETES_POD_SUFFIX = /-[a-z0-9]{8,10}-[a-z0-9]{5}$/;

export function compactPodName(podName: string): string {
  return podName.replace(KUBERNETES_POD_SUFFIX, "");
}
