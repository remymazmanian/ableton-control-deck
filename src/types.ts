export type OscAtom = string | number | boolean;
export interface OscTypedNumber { type: "i" | "f"; value: number }
/** null fills an unused slot in a fixed-width group, such as a scene change with no extra value. */
export type OscArgument = OscAtom | OscTypedNumber | null;

export const oscInt = (value: number): OscTypedNumber => ({ type: "i", value });
export const oscFloat = (value: number): OscTypedNumber => ({ type: "f", value });

export interface OscReply {
  address: string;
  args: OscAtom[];
}

export interface LiveControlClient {
  send(address: string, args?: OscArgument[]): Promise<void>;
  query(address: string, args?: OscArgument[], expectedAddress?: string): Promise<OscReply>;
  /** Byte length of the datagram `send` would transmit. Absent on test doubles. */
  commandBytes?(address: string, args?: readonly OscArgument[]): number;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  dryRun: boolean;
  tool: string;
  data?: T;
  intendedOperations?: Array<{ address: string; args: OscArgument[] }>;
  confirmation?: OscReply;
  error?: { code: string; message: string; details?: unknown };
}

export interface MidiNote {
  pitch: number | string;
  startTime: number;
  duration: number;
  velocity: number;
  mute?: boolean;
}
