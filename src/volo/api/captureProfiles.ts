import { call } from "./invoke";

export type CaptureProfile = Record<string, unknown> & { id: string; name: string };
export interface CaptureProfilesState {
  profiles: CaptureProfile[];
  initialized: boolean;
}

export const listCaptureProfiles = () => call<CaptureProfilesState>("list_capture_profiles");
export const saveCaptureProfiles = (profiles: CaptureProfile[]) =>
  call<void>("save_capture_profiles", { profiles });
