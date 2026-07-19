/* Volo — nDisplay output orchestration bindings.
   Contract: docs/architecture/volo-output-orchestration.md. Nested request
   fields stay snake_case because each Rust command receives one serde DTO. */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { call } from "./invoke";
import type {
  DeployRequest,
  NDisplayOutputEvent,
  NDisplayOutputRunnerEvent,
  OutputCommandResult,
  RuntimePaths,
  RuntimeRequest,
  ShowRequest,
} from "./types";

/** 节点侧 nDisplay 会话路径（三处 UI 共用；preflight 会按机器库覆盖 editor_paths） */
export const DEFAULT_NDISPLAY_OUTPUT_PATHS: RuntimePaths = {
  editor_path: "D:\\Program Files\\Epic Games\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor.exe",
  editor_paths: {},
  project_path: "C:\\ProgramData\\UECM\\ndisplay-output\\VoloOutput\\VoloOutput.uproject",
  config_path: "C:\\ProgramData\\UECM\\ndisplay-output\\VoloOutput\\Config\\VoloOutput.ndisplay",
  manifest_path: "C:\\ProgramData\\UECM\\ndisplay-output\\session\\manifest.json",
  image_dir: "C:\\ProgramData\\UECM\\ndisplay-output\\session\\frames",
};

export const outputPreflight = (request: RuntimeRequest) =>
  call<OutputCommandResult>("output_preflight", { request });

export const outputDeploy = (request: DeployRequest) =>
  call<OutputCommandResult>("output_deploy", { request });

export const outputStart = (request: RuntimeRequest) =>
  call<OutputCommandResult>("output_start", { request });

export const outputShow = (request: ShowRequest) =>
  call<OutputCommandResult>("output_show", { request });

export const outputStop = (request: RuntimeRequest) =>
  call<OutputCommandResult>("output_stop", { request });

export const listenNDisplayOutputEvent = (
  handler: (payload: NDisplayOutputEvent) => void,
): Promise<UnlistenFn> =>
  listen<NDisplayOutputEvent>("ndisplay-output-event", (event) => handler(event.payload));

export const listenNDisplayOutputRunner = (
  handler: (payload: NDisplayOutputRunnerEvent) => void,
): Promise<UnlistenFn> =>
  listen<NDisplayOutputRunnerEvent>("ndisplay-output-runner", (event) => handler(event.payload));
