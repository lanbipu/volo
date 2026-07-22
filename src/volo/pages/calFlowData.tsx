// @ts-nocheck
/* Volo — 校正 · 镜头校正流程 + 上屏部署 数据（徽标 / 摄影机 / 采集会话 / 结构光 / 部署）
   1:1 移植自 Claude Design handoff `cal_flow_data.jsx`；徽标体系一次定义、全局复用。 */
(function () {
  /* ============================================================
     徽标体系（一次定义 · 全局复用）
     ============================================================ */
  const CAL_SOURCE_BADGES = {
    manual:   { label: '手动', tone: 'neutral',     icon: 'sliders', desc: '现场手动输入' },
    profile:  { label: '档案', tone: 'informative', icon: 'doc',     desc: '来自镜头 / 相机档案' },
    tracking: { label: '追踪', tone: 'active',       icon: 'pulse',   desc: '追踪源实时值（只读）' },
    solve:    { label: '求解', tone: 'positive',     icon: 'target',  desc: '本次校正求解结果' },
  };
  const CAL_MODE_BADGES = {
    tracked: { label: '追踪机位', tone: 'active',   icon: 'pulse', desc: '追踪源已接入 · 位姿实时' },
    fixed:   { label: '固定机位', tone: 'neutral',  icon: 'pin',   desc: '无追踪 · 机位在采集期间静止' },
  };
  const CAL_METHOD_BADGES = {
    qsp:     { label: '密集编码点', tone: 'informative', icon: 'grid' },
    charuco: { label: 'ChArUco',    tone: 'neutral',     icon: 'panel' },
    sl:      { label: '结构光点阵', tone: 'positive',    icon: 'target' },
  };
  const CAL_QUALITY_LIGHT = {
    pending: { label: '未评估', tone: 'neutral',  icon: 'minus' },
    ok:      { label: '正常',   tone: 'positive', icon: 'check' },
    warn:    { label: '偏高',   tone: 'notice',   icon: 'alert' },
    fail:    { label: '失败',   tone: 'negative', icon: 'x' },
  };
  const CAL_SOLVE_STATE = {
    none: { label: '未求解',      tone: 'neutral',  icon: 'minus' },
    ok:   { label: '求解成功',    tone: 'positive', icon: 'check' },
    warn: { label: '部分异常',    tone: 'notice',   icon: 'alert' },
    fail: { label: '求解失败',    tone: 'negative', icon: 'x' },
  };

  const CAL_METHODS = [
    { id: 'qsp', name: '密集编码点', sub: 'VP-QSP', avail: true, pattern: 'dots',
      principle: '屏幕逐帧显示格雷码密集编码点阵，相机拍摄后解码出每个点的屏幕坐标。',
      scenes: '现场首选：多点位采集快、对环境光鲁棒。',
      tracking: '支持追踪 / 固定双模式', time: '约 3–6 分钟',
      tags: ['多点位采集快', '抗环境光'] },
    { id: 'charuco', name: 'ChArUco', sub: '棋盘 + ArUco', avail: false, comingSoon: true, pattern: 'board',
      principle: '棋盘格与 ArUco 标记混合板，通用视觉标定生态标准。',
      scenes: '与既有 OpenCV / 通用标定工作流对接。',
      tracking: '固定机位', time: '约 5–8 分钟',
      tags: ['通用生态标准'] },
    { id: 'sl', name: '结构光点阵', sub: '小白点', avail: false, comingSoon: true, pattern: 'whitedots',
      note: '需显示器直连部署',
      principle: '播放结构光白点序列，逐帧亚像素解码点位，精度最高。',
      scenes: '追求最高精度、机位可长时间静止的离线标定。',
      tracking: '采集期间机位必须静止', time: '约 8–15 分钟',
      tags: ['精度最高', '采集期间机位必须静止'] },
  ];

  const CAL_CAMERAS = [
    { id: 'cam1', name: 'Camera 1', mode: 'tracked', protocol: 'freed', cameraId: 3,
      pos: { x: { v: -1820.4, src: 'tracking' }, y: { v: 1420.9, src: 'tracking' }, z: { v: 3160.2, src: 'tracking' } },
      rot: { pan: { v: -12.42, src: 'tracking' }, tilt: { v: 3.08, src: 'tracking' }, roll: { v: 0.14, src: 'tracking' } },
      lens: { sensorW: { v: 23.76, src: 'profile' }, sensorH: { v: 13.365, src: 'profile' },
        focal: { v: 35.2, src: 'profile' }, fovK3: { v: -0.0142, src: 'profile' },
        ppx: { v: 0.31, src: 'profile' }, ppy: { v: -0.18, src: 'profile' },
        zoomEnc: 41240, focusEnc: 28810 } },
    { id: 'cam2', name: 'Camera 2', mode: 'fixed', protocol: null, cameraId: null,
      pos: { x: { v: 0, src: 'manual' }, y: { v: 1500, src: 'manual' }, z: { v: 3200, src: 'manual' } },
      rot: { pan: { v: 0, src: 'manual' }, tilt: { v: 0, src: 'manual' }, roll: { v: 0, src: 'manual' } },
      lens: { sensorW: { v: 36.0, src: 'manual' }, sensorH: { v: 24.0, src: 'manual' },
        focal: { v: 50, src: 'manual' }, fovK3: { v: 0, src: 'manual' },
        ppx: { v: 0, src: 'manual' }, ppy: { v: 0, src: 'manual' }, zoomEnc: null, focusEnc: null } },
    { id: 'cam3', name: 'Camera 3', mode: 'fixed', protocol: null, cameraId: null, solved: true,
      pos: { x: { v: 1712.6, src: 'solve' }, y: { v: 238.4, src: 'solve' }, z: { v: 3041.7, src: 'solve' } },
      rot: { pan: { v: 18.94, src: 'solve' }, tilt: { v: -6.11, src: 'solve' }, roll: { v: -0.22, src: 'solve' } },
      lens: { sensorW: { v: 23.76, src: 'profile' }, sensorH: { v: 13.365, src: 'profile' },
        focal: { v: 28.4, src: 'solve' }, fovK3: { v: -0.0208, src: 'solve' },
        ppx: { v: 0.52, src: 'solve' }, ppy: { v: -0.34, src: 'solve' }, zoomEnc: null, focusEnc: null } },
  ];

  const CAL_TRACK_SOURCE = {
    protocol: 'FreeD', port: 6301, cameraId: 3, packetsPerSec: 100,
    channels: {
      position: { ok: true,  label: '位置' },
      rotation: { ok: true,  label: '旋转' },
      lens:     { ok: true,  label: '镜头' },
    },
  };

  const CAL_CAP_RUNS = [
    { id: 'run_a', label: 'run 02', time: '今天 14:12', method: 'qsp', mode: 'tracked',
      solveState: 'none', rms: null, conf: null, poseCount: 5,
      poses: [
        { id: 'a1', idx: 1, time: '14:12:03', pose: '左 · 中', tracked: true,  detect: 'ok', reproj: 'ok', diff: 'ok',
          rms: 0.48, obs: 214, outliers: 3, missing: [] },
        { id: 'a2', idx: 2, time: '14:12:19', pose: '中偏左',  tracked: true,  detect: 'ok', reproj: 'ok', diff: 'ok',
          rms: 0.51, obs: 205, outliers: 4, missing: [] },
        { id: 'a3', idx: 3, time: '14:12:36', pose: '中',      tracked: true,  detect: 'ok', reproj: 'warn', diff: 'ok',
          rms: 0.83, obs: 188, outliers: 9, missing: ['右上'] },
        { id: 'a4', idx: 4, time: '14:12:52', pose: '中偏右',  tracked: false, detect: 'fail', reproj: 'fail', diff: 'fail',
          rms: null, obs: 0, outliers: 0, missing: ['无追踪配对'] },
        { id: 'a5', idx: 5, time: '14:13:10', pose: '右 · 低',  tracked: true,  detect: 'ok', reproj: 'ok', diff: 'ok',
          rms: 0.54, obs: 197, outliers: 5, missing: [] },
      ] },
    { id: 'run_b', label: 'run 01', time: '今天 11:41', method: 'qsp', mode: 'fixed',
      solveState: 'ok', rms: 0.62, conf: 'high', poseCount: 8,
      poses: [
        { id: 'b1', idx: 1, time: '11:41:02', pose: '固定 · A', tracked: false, detect: 'ok', reproj: 'ok', diff: 'ok', rms: 0.58, obs: 220, outliers: 2, missing: [] },
        { id: 'b2', idx: 2, time: '11:41:20', pose: '固定 · B', tracked: false, detect: 'ok', reproj: 'ok', diff: 'ok', rms: 0.63, obs: 212, outliers: 4, missing: [] },
      ] },
  ];

  const CAL_POSE_OUTLIERS = [
    { id: 142, residual_px: 2.84, uv: [1284, 612] },
    { id: 207, residual_px: 2.11, uv: [1902, 344] },
    { id: 318, residual_px: 1.96, uv: [640, 1088] },
  ];

  const CAL_SL_SEQ = {
    spacing_mm: 12, frames: 128, anchorFrames: 8, encodeFrames: 120,
    duration: '约 2 分 10 秒', fps: 24,
  };

  const CAL_DEPLOY_TARGETS = [
    { id: 'monitor', label: '显示器直连', icon: 'panel',
      desc: '把图案播放器输出到本机直连的 LED 处理器显示器。',
      scene: '单机、单屏或处理器 HDMI 直连的现场，最快上手。' },
    { id: 'cluster', label: 'nDisplay', icon: 'net',
      desc: '经 nDisplay 集群把画面分发到多台渲染服务器上墙。',
      scene: '多节点、大画布、需渲染集群驱动的现场。' },
  ];
  const CAL_DEPLOY_STATE = {
    idle:    { label: '未部署', tone: 'neutral',  icon: 'minus' },
    standby: { label: '黑场待机', tone: 'positive', icon: 'check' },
    showing: { label: '显示中',  tone: 'active',   icon: 'play' },
  };

  /* nDisplay 节点状态 / 部署步骤（部署页进度矩阵；与 handoff data.jsx 对齐） */
  const NDISPLAY_NODE_STATUS = {
    offline:   { label: '离线',   tone: 'neutral',     icon: 'power' },
    ready:     { label: '就绪',   tone: 'informative', icon: 'check' },
    deploying: { label: '部署中', tone: 'notice',      icon: 'sync' },
    running:   { label: '运行中', tone: 'positive',    icon: 'play' },
    error:     { label: '错误',   tone: 'negative',    icon: 'alert' },
  };
  const NDISPLAY_DEPLOY_STEPS = [
    { id: 'artifacts', label: '生成产物',     short: '产物' },
    { id: 'project',   label: '推送工程',     short: '工程' },
    { id: 'session',   label: '推送会话文件', short: '会话' },
    { id: 'verify',    label: '远端校验',     short: '校验' },
  ];

  /* ============================================================
     deployStore · 会话态全局部署状态（不落盘；跨 section 共享）
     status: idle | deploying | ready | showing | error
     channel: 'monitor' | 'ndisplay' | null
     ============================================================ */
  const deployListeners = new Set();
  let deploySnap = { channel: null, status: 'idle', detail: null };
  const deployStore = {
    get: () => deploySnap,
    subscribe: (fn) => { deployListeners.add(fn); return () => deployListeners.delete(fn); },
    patch: (partial) => {
      deploySnap = Object.assign({}, deploySnap, partial);
      deployListeners.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
    },
    /** 从 shell 的 deployState / calOutTarget / deployMeta 同步 */
    syncFromShell: (s) => {
      const channel = s.deployState === 'idle' ? null
        : (s.calOutTarget === 'cluster' ? 'ndisplay' : 'monitor');
      const status = s.deployState === 'idle' ? 'idle'
        : s.deployState === 'showing' ? 'showing'
        : s.deployState === 'deploying' ? 'deploying'
        : 'ready'; /* standby → ready */
      deployStore.patch({ channel, status, detail: s.deployMeta || null });
    },
    isReady: () => {
      const st = deploySnap.status;
      return st === 'ready' || st === 'showing';
    },
  };

  /* ============================================================
     camStore · project.yaml cameras + 三维/面板联动（模块级 + useSyncExternalStore）
     ============================================================ */
  const camListeners = new Set();
  const defaultCamUi = () => ({
    id: 'cam-01', name: 'Camera 1', mode: 'fixed', protocol: null, cameraId: null, solved: false,
    lensConfirmed: false,
    lensIsMaster: false,
    masterLensPath: null,
    masterLensInfo: null,
    pos: { x: { v: 0, src: 'manual' }, y: { v: 1500, src: 'manual' }, z: { v: 3200, src: 'manual' } },
    rot: { pan: { v: 0, src: 'manual' }, tilt: { v: 0, src: 'manual' }, roll: { v: 0, src: 'manual' } },
    lens: {
      sensorW: { v: 36.0, src: 'manual' }, sensorH: { v: 24.0, src: 'manual' },
      focal: { v: 50, src: 'manual' }, fovK3: { v: 0, src: 'manual' },
      ppx: { v: 0, src: 'manual' }, ppy: { v: 0, src: 'manual' },
      zoomEnc: null, focusEnc: null,
    },
    videoProfileId: null, activeRunId: null,
    tracking: null,
    manualPose: { t_mm: [0, 1500, 3200], euler_deg: [0, 0, 0] },
    solvePose: null,
  });
  let camSnap = { cameras: [defaultCamUi()], selectedId: 'cam-01', projectPath: null, dirty: false, saveTimer: null };

  const qualifiedMasterFromYaml = (lens) => {
    const L = lens || {};
    const imageSize = Array.isArray(L.image_size) && L.image_size.length >= 2
      && Number(L.image_size[0]) > 0 && Number(L.image_size[1]) > 0;
    const rms = Number(L.calibration_rms_px);
    return !!(L.is_master === true && L.profile_path
      && L.session_coupled !== true
      && ['multi_view_intrinsics', 'offline_chart'].includes(L.calibration_kind)
      && Number(L.calibration_poses) >= 8
      && Number(L.calibration_points) >= 60
      && L.calibration_rms_px != null && Number.isFinite(rms) && rms < 2
      && imageSize);
  };
  const formalSolveFromYaml = (camera) => {
    const pose = camera && camera.solve_pose;
    const imageSize = pose && Array.isArray(pose.image_size) && pose.image_size.length >= 2
      && Number(pose.image_size[0]) > 0 && Number(pose.image_size[1]) > 0;
    const rms = Number(pose && pose.rms_reprojection_px);
    return !!(pose
      && pose.schema_version === 'volo_stage_pose.v2'
      && pose.solve_kind === 'fixed_extrinsics_only'
      && pose.formal === true
      && pose.preflight_passed === true
      && pose.qualification_passed === true
      && pose.master_lens === true
      && pose.fail_closed === true
      && typeof pose.source_artifact === 'string' && pose.source_artifact.length > 0
      && pose.rms_reprojection_px != null && Number.isFinite(rms) && rms < 2
      && imageSize
      && qualifiedMasterFromYaml(camera.lens));
  };

  const yamlToUi = (c) => {
    const mp = c.manual_pose || { t_mm: [0, 1500, 3200], euler_deg: [0, 0, 0] };
    const rawSolve = c.solve_pose || null;
    const tracked = !!(c.tracking && c.tracking.protocol);
    const L = c.lens || {};
    const qualifiedMaster = qualifiedMasterFromYaml(L);
    const useSolve = formalSolveFromYaml(c);
    const sp = useSolve ? rawSolve : null;
    const t = useSolve ? sp.t_mm : mp.t_mm;
    const e = useSolve ? sp.euler_deg : mp.euler_deg;
    const src = useSolve ? 'solve' : (tracked ? 'tracking' : 'manual');
    return {
      id: c.id, name: c.name || c.id,
      mode: tracked ? 'tracked' : 'fixed',
      protocol: tracked ? c.tracking.protocol : null,
      cameraId: tracked && c.tracking.camera_id != null ? c.tracking.camera_id : null,
      solved: !!sp,
      lensConfirmed: L.sensor_w_mm != null && L.sensor_h_mm != null && L.focal_mm != null,
      lensIsMaster: qualifiedMaster,
      masterLensPath: L.profile_path || null,
      masterLensInfo: L.profile_path ? {
        qualified_master: qualifiedMaster,
        calibration_kind: L.calibration_kind || null,
        image_size: L.image_size || null,
        rms: L.calibration_rms_px != null ? L.calibration_rms_px : null,
        num_images: L.calibration_poses != null ? L.calibration_poses : null,
        num_points: L.calibration_points != null ? L.calibration_points : null,
        session_coupled: L.session_coupled === true,
      } : null,
      pos: { x: { v: t[0], src }, y: { v: t[1], src }, z: { v: t[2], src } },
      rot: { pan: { v: e[0], src }, tilt: { v: e[1], src }, roll: { v: e[2], src } },
      lens: {
        sensorW: { v: L.sensor_w_mm != null ? L.sensor_w_mm : 36, src: L.sensor_w_mm != null ? 'profile' : 'manual' },
        sensorH: { v: L.sensor_h_mm != null ? L.sensor_h_mm : 24, src: L.sensor_h_mm != null ? 'profile' : 'manual' },
        focal: { v: L.focal_mm != null ? L.focal_mm : 50, src: L.focal_mm != null ? 'profile' : 'manual' },
        fovK3: { v: L.k3 != null ? L.k3 : 0, src: L.k3 != null ? 'profile' : 'manual' },
        ppx: { v: L.cx != null ? L.cx : 0, src: L.cx != null ? 'profile' : 'manual' },
        ppy: { v: L.cy != null ? L.cy : 0, src: L.cy != null ? 'profile' : 'manual' },
        k1: L.k1, k2: L.k2,
        zoomEnc: null, focusEnc: null,
      },
      videoProfileId: c.video_profile_id || null,
      activeRunId: c.active_run_id || null,
      tracking: c.tracking || null,
      manualPose: mp,
      solvePose: sp,
    };
  };
  const uiToYaml = (u) => ({
    id: u.id,
    name: u.name,
    lens: {
      sensor_w_mm: u.lens.sensorW.v, sensor_h_mm: u.lens.sensorH.v,
      focal_mm: u.lens.focal.v, k1: u.lens.k1 != null ? u.lens.k1 : null,
      k2: u.lens.k2 != null ? u.lens.k2 : null, k3: u.lens.fovK3.v,
      cx: u.lens.ppx.v, cy: u.lens.ppy.v,
      profile_path: u.masterLensPath || null,
      is_master: !!u.lensIsMaster,
      calibration_kind: u.masterLensInfo && u.masterLensInfo.calibration_kind || null,
      image_size: u.masterLensInfo && u.masterLensInfo.image_size || null,
      calibration_rms_px: u.masterLensInfo && u.masterLensInfo.rms != null ? u.masterLensInfo.rms : null,
      calibration_poses: u.masterLensInfo && u.masterLensInfo.num_images != null ? u.masterLensInfo.num_images : null,
      calibration_points: u.masterLensInfo && u.masterLensInfo.num_points != null ? u.masterLensInfo.num_points : null,
      session_coupled: !!(u.masterLensInfo && u.masterLensInfo.session_coupled),
    },
    tracking: u.tracking || (u.protocol ? { protocol: u.protocol, host: '0.0.0.0', port: 6301, camera_id: u.cameraId } : null),
    video_profile_id: u.videoProfileId || null,
    manual_pose: u.manualPose || {
      t_mm: [u.pos.x.v, u.pos.y.v, u.pos.z.v],
      euler_deg: [u.rot.pan.v, u.rot.tilt.v, u.rot.roll.v],
    },
    solve_pose: u.solvePose || null,
    active_run_id: u.activeRunId || null,
  });

  const camStore = {
    get: () => camSnap,
    subscribe: (fn) => { camListeners.add(fn); return () => camListeners.delete(fn); },
    notify: () => camListeners.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } }),
    patch: (partial) => { camSnap = Object.assign({}, camSnap, partial); camStore.notify(); },
    selected: () => camSnap.cameras.find((c) => c.id === camSnap.selectedId) || camSnap.cameras[0] || null,
    select: (id) => camStore.patch({ selectedId: id }),
    /** 从打开的项目 config.cameras 灌入；无则保留默认一机 */
    loadFromProject: (projectPath, config) => {
      const configured = config && Array.isArray(config.cameras) ? config.cameras : [];
      const invalidPersistedSolve = configured.some((camera) => (
        camera && camera.solve_pose && !formalSolveFromYaml(camera)
      ));
      const list = configured.length
        ? configured.map(yamlToUi)
        : [defaultCamUi()];
      camSnap = {
        cameras: list,
        selectedId: list[0].id,
        projectPath: projectPath || null,
        dirty: invalidPersistedSolve,
        saveTimer: camSnap.saveTimer,
      };
      camStore.notify();
      if (invalidPersistedSolve) camStore.scheduleSave();
    },
    upsert: (cam) => {
      const cams = camSnap.cameras.slice();
      const i = cams.findIndex((c) => c.id === cam.id);
      if (i >= 0) cams[i] = cam; else cams.push(cam);
      camStore.patch({ cameras: cams, dirty: true });
      camStore.scheduleSave();
    },
    add: () => {
      const n = camSnap.cameras.length + 1;
      const id = 'cam-' + String(n).padStart(2, '0') + '-' + Date.now().toString(36).slice(-4);
      const cam = Object.assign(defaultCamUi(), { id, name: 'Camera ' + n });
      camStore.patch({ cameras: camSnap.cameras.concat([cam]), selectedId: id, dirty: true });
      camStore.scheduleSave();
      return cam;
    },
    remove: (id) => {
      if (camSnap.cameras.length <= 1) return;
      const cams = camSnap.cameras.filter((c) => c.id !== id);
      camStore.patch({
        cameras: cams,
        selectedId: camSnap.selectedId === id ? cams[0].id : camSnap.selectedId,
        dirty: true,
      });
      camStore.scheduleSave();
    },
    rename: (id, name) => {
      const cams = camSnap.cameras.map((c) => c.id === id ? Object.assign({}, c, { name }) : c);
      camStore.patch({ cameras: cams, dirty: true });
      camStore.scheduleSave();
    },
    setManualPose: (id, t_mm, euler_deg) => {
      const cams = camSnap.cameras.map((c) => {
        if (c.id !== id) return c;
        const mp = { t_mm: t_mm.slice(), euler_deg: euler_deg.slice() };
        return Object.assign({}, c, {
          manualPose: mp, solvePose: c.solvePose, solved: !!c.solvePose,
          mode: c.tracking ? 'tracked' : 'fixed',
          pos: {
            x: { v: t_mm[0], src: 'manual' }, y: { v: t_mm[1], src: 'manual' }, z: { v: t_mm[2], src: 'manual' },
          },
          rot: {
            pan: { v: euler_deg[0], src: 'manual' }, tilt: { v: euler_deg[1], src: 'manual' }, roll: { v: euler_deg[2], src: 'manual' },
          },
        });
      });
      camStore.patch({ cameras: cams, dirty: true });
      camStore.scheduleSave();
    },
    setLensValue: (id, key, value) => {
      if (!Number.isFinite(value)) return;
      const cameras = camSnap.cameras.map((camera) => {
        if (camera.id !== id) return camera;
        const lens = Object.assign({}, camera.lens);
        if (key === 'sensorW') lens.sensorW = { v: value, src: 'manual' };
        else if (key === 'sensorH') lens.sensorH = { v: value, src: 'manual' };
        else if (key === 'focal') lens.focal = { v: value, src: 'manual' };
        else if (key === 'k3') lens.fovK3 = { v: value, src: 'manual' };
        else if (key === 'ppx') lens.ppx = { v: value, src: 'manual' };
        else if (key === 'ppy') lens.ppy = { v: value, src: 'manual' };
        return Object.assign({}, camera, {
          lens, lensConfirmed: true,
          lensIsMaster: false, masterLensPath: null, masterLensInfo: null,
        });
      });
      camStore.patch({ cameras, dirty: true });
      camStore.scheduleSave();
    },
    setMasterLens: (id, path, info) => {
      const cameras = camSnap.cameras.map((camera) => {
        if (camera.id !== id) return camera;
        return Object.assign({}, camera, {
          lensIsMaster: !!(path && info && info.qualified_master),
          masterLensPath: path || null,
          masterLensInfo: info || null,
        });
      });
      camStore.patch({ cameras, dirty: true });
      camStore.scheduleSave();
    },
    setSolvePose: (id, t_mm, euler_deg, lensPatch, poseMeta) => {
      const cams = camSnap.cameras.map((c) => {
        if (c.id !== id) return c;
        const sp = Object.assign({
          t_mm: t_mm.slice(), euler_deg: euler_deg.slice(),
          formal: false, preflight_passed: false,
        }, poseMeta || {});
        const lens = lensPatch
          ? Object.assign({}, c.lens, {
              focal: { v: lensPatch.focal_mm != null ? lensPatch.focal_mm : c.lens.focal.v, src: 'solve' },
              fovK3: { v: lensPatch.k3 != null ? lensPatch.k3 : c.lens.fovK3.v, src: lensPatch.k3 != null ? 'solve' : c.lens.fovK3.src },
              ppx: { v: lensPatch.cx != null ? lensPatch.cx : c.lens.ppx.v, src: lensPatch.cx != null ? 'solve' : c.lens.ppx.src },
              ppy: { v: lensPatch.cy != null ? lensPatch.cy : c.lens.ppy.v, src: lensPatch.cy != null ? 'solve' : c.lens.ppy.src },
              k1: lensPatch.k1 != null ? lensPatch.k1 : c.lens.k1,
              k2: lensPatch.k2 != null ? lensPatch.k2 : c.lens.k2,
            })
          : c.lens;
        return Object.assign({}, c, {
          solvePose: sp, solved: true,
          pos: { x: { v: t_mm[0], src: 'solve' }, y: { v: t_mm[1], src: 'solve' }, z: { v: t_mm[2], src: 'solve' } },
          rot: { pan: { v: euler_deg[0], src: 'solve' }, tilt: { v: euler_deg[1], src: 'solve' }, roll: { v: euler_deg[2], src: 'solve' } },
          lens,
        });
      });
      camStore.patch({ cameras: cams, dirty: true });
      camStore.scheduleSave();
    },
    setTracking: (id, tracking) => {
      const cams = camSnap.cameras.map((c) => {
        if (c.id !== id) return c;
        return Object.assign({}, c, {
          tracking,
          protocol: tracking ? tracking.protocol : null,
          cameraId: tracking && tracking.camera_id != null ? tracking.camera_id : null,
          mode: tracking ? 'tracked' : 'fixed',
        });
      });
      camStore.patch({ cameras: cams, dirty: true });
      camStore.scheduleSave();
    },
    scheduleSave: () => {
      if (camSnap.saveTimer) clearTimeout(camSnap.saveTimer);
      camSnap.saveTimer = setTimeout(() => { void camStore.flush(); }, 600);
    },
    flush: async () => {
      const path = camSnap.projectPath;
      if (!path || !window.VOLO_CAL2 || !window.VOLO_CAL2.saveProjectCameras) return;
      try {
        await window.VOLO_CAL2.saveProjectCameras(path, camSnap.cameras.map(uiToYaml));
        camStore.patch({ dirty: false });
      } catch (e) { /* 调用方日志 */ }
    },
    /** 三维层消费：mm → m，FOV 由 focal+sensor 估算 */
    sceneCameras: () => camSnap.cameras.map((c) => {
      const sw = c.lens.sensorW.v || 36, f = c.lens.focal.v || 50;
      const hfovDeg = 2 * Math.atan(sw / (2 * f)) * (180 / Math.PI);
      const t = [c.pos.x.v / 1000, c.pos.y.v / 1000, c.pos.z.v / 1000];
      const e = [c.rot.pan.v, c.rot.tilt.v, c.rot.roll.v];
      return {
        id: c.id, name: c.name, selected: c.id === camSnap.selectedId,
        t_m: t, euler_deg: e, hfovDeg, solved: !!c.solved, mode: c.mode,
        dragEnabled: c.mode === 'fixed' && !c.solved,
      };
    }),
  };

  Object.assign(window, {
    CAL_SOURCE_BADGES, CAL_MODE_BADGES, CAL_METHOD_BADGES, CAL_QUALITY_LIGHT, CAL_SOLVE_STATE,
    CAL_METHODS, CAL_CAMERAS, CAL_TRACK_SOURCE, CAL_CAP_RUNS, CAL_POSE_OUTLIERS, CAL_SL_SEQ,
    CAL_DEPLOY_TARGETS, CAL_DEPLOY_STATE, NDISPLAY_NODE_STATUS, NDISPLAY_DEPLOY_STEPS,
    deployStore, camStore,
  });
  if (window.VOLO_CAL2) {
    window.VOLO_CAL2.deployStore = deployStore;
    window.VOLO_CAL2.camStore = camStore;
  } else {
    window.VOLO_CAL2 = { deployStore, camStore };
  }
})();
