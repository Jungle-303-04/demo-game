import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class AdmissionFailureState {
  constructor(private readonly markerPath: string) {
    if (!markerPath.trim()) throw new Error("admission_failure_marker_path_required");
  }

  failed(): boolean {
    return existsSync(this.markerPath);
  }

  trip(): void {
    mkdirSync(dirname(this.markerPath), { recursive: true });
    writeFileSync(this.markerPath, `${new Date().toISOString()}\n`, { encoding: "utf8" });
  }

  recover(): void {
    rmSync(this.markerPath, { force: true });
  }
}
