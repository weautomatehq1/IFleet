export interface Capabilities {
  version: string;
  updated: string;
  shells: string[];
  clis: Record<string, string>;
  mcps: string[];
  auth: Record<string, boolean>;
  notes?: string;
}

export function isCapabilityAvailable(cap: string, capabilities: Capabilities): boolean {
  const normalized = cap.toLowerCase().trim();
  if (capabilities.shells.some((s) => s.toLowerCase() === normalized)) return true;
  if (Object.keys(capabilities.clis).some((k) => k.toLowerCase() === normalized)) return true;
  if (capabilities.mcps.some((m) => m.toLowerCase() === normalized)) return true;
  return false;
}
