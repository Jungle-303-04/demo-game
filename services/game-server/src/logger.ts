import type { StructuredLog } from "./types.js";

export type LogSink = (event: StructuredLog) => void;

export const consoleJsonLog: LogSink = (event) => {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
};

export class CapturingLogSink {
  readonly events: StructuredLog[] = [];
  emit: LogSink = (event) => { this.events.push(event); };

  byEvent(event: string): StructuredLog[] {
    return this.events.filter((entry) => entry.event === event);
  }
}
