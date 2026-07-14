import { call } from "./invoke";

export type CaptureProfile = Record<string, unknown> & { id: string; name: string };
export interface CaptureProfilesState {
  profiles: CaptureProfile[];
  initialized: boolean;
}

export const listCaptureProfiles = () => call<CaptureProfilesState>("list_capture_profiles");
export const saveCaptureProfiles = (profiles: CaptureProfile[]) =>
  call<void>("save_capture_profiles", { profiles });

export interface TrackingProbeResult {
  frames: number;
  latest: Record<string, unknown> | null;
}
export const probeTrackingSource = (protocol: string, host: string, port: number) =>
  call<TrackingProbeResult>("probe_tracking_source", { protocol, host, port });

export interface SidecarError {
  code?: string;
  message: string;
  details?: Record<string, unknown>;
}

export const parseSidecarError = (error: unknown): SidecarError => {
  const objectValue = error && typeof error === "object" && "message" in error
    ? error as { code?: unknown; message: unknown; details?: unknown }
    : null;
  const raw = objectValue
    ? String(objectValue.message)
    : String(error ?? "Unknown sidecar error");
  try {
    const value = JSON.parse(raw) as SidecarError;
    if (value && typeof value.message === "string") return value;
  } catch {
    // Tauri may reject with a plain string when the failure predates vpcal.
  }
  return {
    code: objectValue && typeof objectValue.code === "string" ? objectValue.code : undefined,
    message: raw,
    details: objectValue?.details && typeof objectValue.details === "object"
      ? objectValue.details as Record<string, unknown>
      : undefined,
  };
};

export interface VideoSourceInfo {
  width: number;
  height: number;
  fps: number | null;
  fourcc: string | null;
  pixel_format?: string | null;
  bit_depth: number;
  is_hx: boolean;
  transfer_function?: string;
}

export interface DecklinkConnector {
  id: string;
  name: string;
}
/** NDI source: `{ name }`. DeckLink device: `{ index, name, connectors }`. */
export interface VideoSourceEntry {
  name: string;
  index?: number;
  connectors?: DecklinkConnector[];
}

export interface VideoSourceList {
  backend: string;
  timeout_s: number;
  sources: VideoSourceEntry[];
}

export const enumerateVideoSources = (backend: string, timeoutS = 3) =>
  call<VideoSourceList>("enumerate_video_sources", { backend, timeoutS });

export const probeVideoSource = (input: {
  backend: string; device: string; width?: number | null; height?: number | null;
  fps?: number | null; transferFunction: string;
}) => call<{
  frames: number;
  mean_fps: number;
  preview_data_url: string | null;
  source: VideoSourceInfo | null;
}>("probe_video_source", input);
