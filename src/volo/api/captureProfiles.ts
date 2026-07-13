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

export const probeVideoSource = (input: {
  backend: string; device: string; width?: number | null; height?: number | null;
  fps?: number | null; transferFunction: string;
}) => call<{frames: number; mean_fps: number; preview_data_url: string | null}>("probe_video_source", input);
