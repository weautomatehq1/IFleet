export interface Event {
  ts: number;
  sprintId: string;
  taskId?: string;
  workerId?: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface TailOptions {
  fromTs?: number;
}

export interface EventLog {
  append(event: Event): void;
  tail(sprintId: string, opts?: TailOptions): AsyncIterable<Event>;
  read(sprintId: string): Event[];
}
