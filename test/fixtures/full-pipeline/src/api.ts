// Pattern: silent error handling — catch that only console.errors with no user feedback.
// Scanner should flag this.

export interface AppConfig {
  apiBaseUrl: string;
  featureFlags: Record<string, boolean>;
}

export async function loadConfig(): Promise<AppConfig | null> {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as AppConfig;
  } catch (err) {
    console.error(err);
    return null;
  }
}

export async function saveConfig(cfg: AppConfig): Promise<boolean> {
  try {
    const res = await fetch("/api/config", {
      method: "PUT",
      body: JSON.stringify(cfg),
    });
    return res.ok;
  } catch (err) {
    console.error(err);
    return false;
  }
}
