import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 小红书标题加权字数（向上取整，上限 20）：
 * ASCII 字符（字母、数字、半角空格、半角标点）计 0.5，其余字符计 1，合计后 Math.ceil。
 */
export function calcXhsTitleWeight(title) {
  let sum = 0;
  for (const ch of String(title || "")) {
    const code = ch.codePointAt(0);
    sum += code <= 0x7f ? 0.5 : 1;
  }
  return Math.ceil(sum);
}

/**
 * 抖音标题字数（上限 30）：
 * 普通字符计 1，emoji / 非 BMP 扩展象形文字实测计 2。
 */
export function calcDouyinTitleLength(title) {
  let sum = 0;
  for (const ch of String(title || "")) {
    sum += /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
  }
  return sum;
}

/**
 * 用 ffprobe 探测成片真实元数据与旋转后实际显示方向。
 */
export function probeVideo(videoPath) {
  const out = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=format_name,duration,size,bit_rate:format_tags=title,comment",
      "-show_entries",
      "stream=codec_type,codec_name,profile,pix_fmt,width,height,display_aspect_ratio:stream_side_data=rotation",
      "-of",
      "json",
      videoPath,
    ],
    { encoding: "utf-8", timeout: 15000 }
  );
  const info = JSON.parse(out);
  const vStream = (info.streams || []).find((s) => s.codec_type === "video");
  const aStream = (info.streams || []).find((s) => s.codec_type === "audio");
  if (!vStream) throw new Error(`视频中未找到有效 video 流: ${videoPath}`);

  let rotation = 0;
  for (const sd of vStream.side_data_list || []) {
    if (typeof sd.rotation === "number") rotation = sd.rotation;
  }
  const absRot = Math.abs(rotation) % 360;
  const swapped = absRot === 90 || absRot === 270;
  const displayWidth = swapped ? Number(vStream.height) : Number(vStream.width);
  const displayHeight = swapped ? Number(vStream.width) : Number(vStream.height);
  const orientation =
    displayHeight > displayWidth
      ? "portrait"
      : displayWidth > displayHeight
        ? "landscape"
        : "square";

  return {
    path: path.resolve(videoPath),
    formatName: info.format?.format_name || "",
    durationSec: Number(Number(info.format?.duration || 0).toFixed(2)),
    sizeBytes: Number(info.format?.size || 0),
    videoCodec: vStream.codec_name || "",
    videoProfile: vStream.profile || "",
    pixFmt: vStream.pix_fmt || "",
    audioCodec: aStream?.codec_name || "",
    width: displayWidth,
    height: displayHeight,
    rotation,
    orientation,
    tags: info.format?.tags || {},
  };
}

/**
 * 多点快速抽帧探测成片有效画幅（Active Viewport / 黑边错配检测）。
 * - 统一经 format=yuv420p 转 8-bit，避免达芬奇 10-bit HEVC (TV range 黑电平=64) 导致 cropdetect=limit=24 失效；
 * - 对多帧有效框取并集（Union Box），防止单帧暗部/黑衣服误裁或正常视频中偶发竖屏插片误报；
 * - 双向覆盖「竖屏误导成横屏时间线 (pillarbox)」与「横屏误导成竖屏时间线 (letterbox)」。
 */
export function probeVideoActiveViewport(videoPath, videoMeta) {
  const w = Number(videoMeta?.width || 0);
  const h = Number(videoMeta?.height || 0);
  const dur = Number(videoMeta?.durationSec || 0);
  const containerOrientation = videoMeta?.orientation || (h > w ? "portrait" : w > h ? "landscape" : "square");
  if (w <= 0 || h <= 0) {
    return { status: "skipped", reason: "invalid_dimensions" };
  }

  const fracs = dur >= 1.5 ? [0.12, 0.30, 0.50, 0.70, 0.88] : [0.5];
  const boxes = [];
  const t0 = Date.now();

  for (const frac of fracs) {
    const ts = dur > 0.2 ? Math.max(0.05, Math.min(dur - 0.05, dur * frac)) : 0;
    const proc = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-v",
        "info",
        "-ss",
        ts.toFixed(2),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-vf",
        "format=yuv420p,cropdetect=limit=24:round=2:reset=0:skip=0",
        "-f",
        "null",
        "-",
      ],
      { encoding: "utf-8", timeout: 8000 }
    );
    if (proc.error) {
      return { status: "skipped", reason: `ffmpeg_unavailable: ${proc.error.message}`, elapsedMs: Date.now() - t0 };
    }
    const matches = [...(proc.stderr || "").matchAll(/x1:(\d+)\s+x2:(\d+)\s+y1:(\d+)\s+y2:(\d+)\s+w:(\d+)\s+h:(\d+)/g)];
    if (!matches.length) continue;
    const last = matches[matches.length - 1];
    const [x1, x2, y1, y2, cw, ch] = last.slice(1).map(Number);
    if (cw <= 0 || ch <= 0) continue;
    if (cw * ch < w * h * 0.04) continue; // 忽略纯黑转场帧
    boxes.push({ ts: Number(ts.toFixed(2)), x1, x2, y1, y2, cw, ch });
  }

  const elapsedMs = Date.now() - t0;
  if (!boxes.length) {
    return { status: "skipped", reason: "no_non_black_frames", samplesCount: 0, elapsedMs };
  }

  const ux1 = Math.min(...boxes.map((b) => b.x1));
  const ux2 = Math.max(...boxes.map((b) => b.x2));
  const uy1 = Math.min(...boxes.map((b) => b.y1));
  const uy2 = Math.max(...boxes.map((b) => b.y2));
  const uw = Math.min(w, ux2 - ux1 + 1);
  const uh = Math.min(h, uy2 - uy1 + 1);

  const activeOrientation = uh > uw ? "portrait" : uw > uh ? "landscape" : "square";
  const fillWidthPct = Number(((uw / w) * 100).toFixed(1));
  const fillHeightPct = Number(((uh / h) * 100).toFixed(1));
  const leftBarPct = Number(((ux1 / w) * 100).toFixed(1));
  const rightBarPct = Number((((w - 1 - ux2) / w) * 100).toFixed(1));
  const topBarPct = Number(((uy1 / h) * 100).toFixed(1));
  const bottomBarPct = Number((((h - 1 - uy2) / h) * 100).toFixed(1));

  const isPillarboxMismatch =
    containerOrientation === "landscape" &&
    activeOrientation === "portrait" &&
    fillWidthPct < 75 &&
    leftBarPct >= 12 &&
    rightBarPct >= 12;

  const isLetterboxMismatch =
    containerOrientation === "portrait" &&
    activeOrientation === "landscape" &&
    fillHeightPct < 75 &&
    topBarPct >= 12 &&
    bottomBarPct >= 12;

  // 检查是否存在“片头/片尾全屏撑大并集，但主体 ≥80% 帧仍为异向大黑边”的情况
  let frameMismatchCount = 0;
  for (const b of boxes) {
    const fOrient = b.ch > b.cw ? "portrait" : b.cw > b.ch ? "landscape" : "square";
    const fFillW = (b.cw / w) * 100;
    const fFillH = (b.ch / h) * 100;
    const fLeft = (b.x1 / w) * 100;
    const fRight = ((w - 1 - b.x2) / w) * 100;
    const fTop = (b.y1 / h) * 100;
    const fBottom = ((h - 1 - b.y2) / h) * 100;
    if (
      (containerOrientation === "landscape" && fOrient === "portrait" && fFillW < 75 && fLeft >= 12 && fRight >= 12) ||
      (containerOrientation === "portrait" && fOrient === "landscape" && fFillH < 75 && fTop >= 12 && fBottom >= 12)
    ) {
      frameMismatchCount += 1;
    }
  }

  let status = "ok";
  let mismatchType = null;
  if (isPillarboxMismatch) {
    status = "mismatch_error";
    mismatchType = "pillarbox_portrait_in_landscape";
  } else if (isLetterboxMismatch) {
    status = "mismatch_error";
    mismatchType = "letterbox_landscape_in_portrait";
  } else if (boxes.length >= 3 && frameMismatchCount / boxes.length >= 0.8) {
    status = "warning";
    mismatchType = "majority_frames_orientation_mismatch";
  } else if (
    (fillWidthPct < 75 && leftBarPct >= 12 && rightBarPct >= 12) ||
    (fillHeightPct < 70 && topBarPct >= 15 && bottomBarPct >= 15)
  ) {
    status = "warning";
    mismatchType = "heavy_symmetric_black_bars";
  }

  return {
    status,
    mismatchType,
    containerOrientation,
    activeOrientation,
    activeWidth: uw,
    activeHeight: uh,
    activeRatio: uh > 0 ? Number((uw / uh).toFixed(3)) : 0,
    fillWidthPct,
    fillHeightPct,
    barsPct: { left: leftBarPct, right: rightBarPct, top: topBarPct, bottom: bottomBarPct },
    samplesCount: boxes.length,
    frameMismatchCount,
    elapsedMs,
  };
}

/**
 * 探测图片真实像素尺寸（macOS sips 或 ffprobe 兜底）。
 */
export function probeImage(imgPath) {
  const abs = path.resolve(imgPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`封面文件不存在: ${abs}`);
  }
  try {
    const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", abs], {
      encoding: "utf-8",
      timeout: 8000,
    });
    const w = Number(out.match(/pixelWidth:\s*(\d+)/)?.[1] || 0);
    const h = Number(out.match(/pixelHeight:\s*(\d+)/)?.[1] || 0);
    if (w > 0 && h > 0) {
      return { path: abs, width: w, height: h, ratio: Number((w / h).toFixed(3)) };
    }
  } catch {
    // fallback to ffprobe below
  }
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", abs],
    { encoding: "utf-8", timeout: 8000 }
  );
  const s = JSON.parse(out).streams?.[0] || {};
  const w = Number(s.width || 0);
  const h = Number(s.height || 0);
  return { path: abs, width: w, height: h, ratio: h > 0 ? Number((w / h).toFixed(3)) : 0 };
}

const VALID_PLATFORMS = ["xhs", "douyin", "bilibili", "wechat", "x"];
export const WECHAT_NO_LOCATION = "不显示位置";

/**
 * 归一化单平台地点配置：绝不写死具体地标；留空或「不显示位置」时按平台返回空串或「不显示位置」。
 */
function resolvePlatformLocation(platformCfg, topLocation, topLocationQuery, isWechat = false) {
  const hasPlatformLoc = platformCfg && Object.prototype.hasOwnProperty.call(platformCfg, "location");
  const raw = hasPlatformLoc ? platformCfg.location : topLocation;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed || trimmed === WECHAT_NO_LOCATION) {
    return {
      location: isWechat ? WECHAT_NO_LOCATION : "",
      locationQuery: isWechat ? WECHAT_NO_LOCATION : "",
    };
  }
  const queryRaw =
    (platformCfg && typeof platformCfg.locationQuery === "string" && platformCfg.locationQuery.trim()) ||
    (typeof topLocationQuery === "string" && topLocationQuery.trim()) ||
    trimmed;
  return { location: trimmed, locationQuery: queryRaw };
}

/**
 * 校验并标准化任务配置，返回含探测元数据与默认推导结果的 normalizedJob。
 * 绝不擅自截断未超限标题或静默改词；超限或缺失硬要素直接抛出清晰错误。
 */
export function validateAndNormalizeJob(rawJob, options = {}) {
  const errors = [];
  const warnings = [];
  const job = structuredClone(rawJob || {});

  if (!job.title || typeof job.title !== "string" || !job.title.trim()) {
    errors.push("缺少必填字段 title（原标题）。");
  }
  const title = (job.title || "").trim();

  const platforms = Array.isArray(job.platforms) && job.platforms.length
    ? job.platforms
    : [...VALID_PLATFORMS];
  for (const p of platforms) {
    if (!VALID_PLATFORMS.includes(p)) {
      errors.push(`未知平台标识 "${p}"，仅支持: ${VALID_PLATFORMS.join(", ")}`);
    }
  }

  // 标题硬上限检查
  const xhsWeight = calcXhsTitleWeight(title);
  const dyLen = calcDouyinTitleLength(title);
  const biliLen = [...title].length;
  if (platforms.includes("xhs") && xhsWeight > 20 && !job.xhs?.title) {
    errors.push(`小红书标题加权计数为 ${xhsWeight}/20（超限），请在 job.xhs.title 显式提供协商后的小红书标题。`);
  }
  if (platforms.includes("xhs") && job.xhs?.title) {
    const customW = calcXhsTitleWeight(job.xhs.title);
    if (customW > 20) errors.push(`job.xhs.title 加权计数为 ${customW}/20（仍超限）。`);
  }
  if (platforms.includes("douyin") && dyLen > 30 && !job.douyin?.title) {
    errors.push(`抖音标题字数为 ${dyLen}/30（超限），请在 job.douyin.title 显式提供协商后的抖音标题。`);
  }
  if (platforms.includes("douyin") && job.douyin?.title) {
    const customDy = calcDouyinTitleLength(job.douyin.title);
    if (customDy > 30) errors.push(`job.douyin.title 字数为 ${customDy}/30（仍超限）。`);
  }
  if (platforms.includes("bilibili") && biliLen > 80) {
    errors.push(`B 站标题字数为 ${biliLen}/80（超限）。`);
  }
  const xTitle = (job.x?.title || title).trim();
  if (platforms.includes("x") && [...xTitle].length > 70) {
    errors.push(`X 媒体标题字数为 ${[...xTitle].length}/70（超限），请在 job.x.title 显式提供 ≤70 字标题。`);
  }

  const shortTitle = job.wechat?.shortTitle || "";
  if (shortTitle) {
    if ([...shortTitle].length > 16) {
      errors.push(`微信视频号短标题超限（${[...shortTitle].length}/16）。`);
    }
    if (shortTitle.includes("，")) {
      errors.push("微信视频号短标题禁止包含中文逗号「，」。");
    }
  }

  if (typeof job.aiGenerated !== "boolean") {
    errors.push("必须显式声明 aiGenerated (true/false)，不可由脚本猜测是否含 AI 生成素材。");
  }

  const original = job.original !== false; // 默认本人自制原创，可显式设为 false
  const allowActivities = job.allowActivities === true; // 全平台红线：默认绝不关联任何活动，仅当用户明确提起并显式开启时才允许
  const allowBlackBars = job.allowBlackBars === true; // 仅在作者明确确认有意留黑边/异向套框时放行

  // 探测成片（含有效画幅黑边错配检测；pass2/finish 可传 skipFrameAudit 跳过以实现零额外耗时）
  let videoMeta = null;
  let activeViewport = null;
  if (!job.video) {
    errors.push("缺少必填字段 video（本地成片绝对路径）。");
  } else if (!fs.existsSync(job.video)) {
    errors.push(`本地成片不存在: ${job.video}`);
  } else if (!options.skipProbe) {
    videoMeta = probeVideo(job.video);
    if (!options.skipFrameAudit) {
      activeViewport = probeVideoActiveViewport(job.video, videoMeta);
      videoMeta.activeViewport = activeViewport;
      if (activeViewport.status === "mismatch_error") {
        const desc =
          activeViewport.mismatchType === "pillarbox_portrait_in_landscape"
            ? `疑似「竖屏素材误导成横屏时间线」（左右黑边左 ${activeViewport.barsPct.left}% / 右 ${activeViewport.barsPct.right}%，有效宽仅占 ${activeViewport.fillWidthPct}%）`
            : `疑似「横屏素材误导成竖屏时间线」（上下黑边上 ${activeViewport.barsPct.top}% / 下 ${activeViewport.barsPct.bottom}%，有效高仅占 ${activeViewport.fillHeightPct}%）`;
        const msg =
          `成片有效画幅方向与容器冲突：${desc}。容器 ${videoMeta.width}×${videoMeta.height}（${videoMeta.orientation}），` +
          `5 帧并集有效画面 ${activeViewport.activeWidth}×${activeViewport.activeHeight}（${activeViewport.activeOrientation}）。` +
          `请先核对达芬奇/剪辑软件时间线分辨率并重新导出；若作者明确确认就是要带黑边发此版，请在 job.json 显式写入 "allowBlackBars": true 放行。`;
        if (allowBlackBars) {
          warnings.push(`[已授权 allowBlackBars=true 放行] ${msg}`);
        } else {
          errors.push(msg);
        }
      } else if (activeViewport.status === "warning") {
        warnings.push(
          `成片存在较明显对称黑边或主体帧方向异常（${activeViewport.mismatchType}）：容器 ${videoMeta.width}×${videoMeta.height}，有效画面 ${activeViewport.activeWidth}×${activeViewport.activeHeight}（宽占比 ${activeViewport.fillWidthPct}% / 高占比 ${activeViewport.fillHeightPct}%），建议发车前确认。`
        );
      }
    }
  } else {
    videoMeta = {
      path: path.resolve(job.video),
      orientation: job.orientation || "portrait",
      durationSec: 0,
      width: 0,
      height: 0,
      sizeBytes: fs.statSync(job.video).size,
    };
  }

  // 探测封面图
  const covers = {};
  const rawCovers = job.covers || {};
  for (const key of ["3x4", "4x3", "16x9", "9x16"]) {
    if (rawCovers[key]) {
      if (!fs.existsSync(rawCovers[key])) {
        errors.push(`封面 ${key} 文件不存在: ${rawCovers[key]}`);
      } else {
        covers[key] = options.skipProbe
          ? { path: path.resolve(rawCovers[key]) }
          : probeImage(rawCovers[key]);
      }
    }
  }

  // 推导小红书默认封面比例（竖屏 3:4 / 横屏 4:3）
  const orientation = videoMeta?.orientation || "portrait";
  let xhsCoverRatio = job.xhs?.coverRatio || (orientation === "landscape" ? "4x3" : "3x4");
  if (!covers[xhsCoverRatio]) {
    const avail = Object.keys(covers);
    if (avail.length === 1 && job.xhs?.allowSingleCoverFallback) {
      xhsCoverRatio = avail[0];
      warnings.push(`小红书未提供默认 ${orientation === "landscape" ? "4x3" : "3x4"} 封面，按授权使用唯一来图 ${xhsCoverRatio}。`);
    } else if (platforms.includes("xhs")) {
      warnings.push(`小红书目标封面比例为 ${xhsCoverRatio}，但 job.covers["${xhsCoverRatio}"] 未提供；将保留平台默认并记录待补。`);
    }
  }

  // 小红书可选独立视频路径（如高码率 8-bit H.264 MP4 兼容版）与 10-bit HEVC .mov 预警
  let xhsVideoPath = null;
  if (job.xhs?.videoPath) {
    if (!fs.existsSync(job.xhs.videoPath)) {
      errors.push(`小红书指定视频文件不存在: ${job.xhs.videoPath}`);
    } else {
      xhsVideoPath = path.resolve(job.xhs.videoPath);
    }
  } else if (platforms.includes("xhs") && videoMeta) {
    const is10BitHevc =
      videoMeta.videoCodec === "hevc" &&
      (/10/.test(videoMeta.pixFmt || "") || /Main 10/i.test(videoMeta.videoProfile || ""));
    const isPcmAudio = /^pcm_/.test(videoMeta.audioCodec || "");
    const isMov = path.extname(videoMeta.path).toLowerCase() === ".mov";
    if (isMov && (is10BitHevc || isPcmAudio)) {
      warnings.push(
        `成片为 ${videoMeta.videoCodec}(${videoMeta.pixFmt || videoMeta.videoProfile || "10bit"}) / ${videoMeta.audioCodec} .mov：小红书默认先按正常流程直接上传原片（切勿提前预防性转码）；仅在实测前端无响应或进度停在 0% 时，再征得作者同意仅为小红书生成 8-bit H.264 + AAC MP4 并写入 job.xhs.videoPath 兜底。`
      );
    }
  }

  let xVideoPath = null;
  if (job.x?.videoPath) {
    if (!fs.existsSync(job.x.videoPath)) {
      errors.push(`X 指定视频文件不存在: ${job.x.videoPath}`);
    } else {
      xVideoPath = path.resolve(job.x.videoPath);
    }
  }

  // 推导 X（Media Studio）默认封面比例（同微信视频号/小红书：竖屏 9:16 优先其次 3:4，横屏 16:9）
  const xDefaultRatio =
    orientation === "portrait"
      ? (covers["9x16"] ? "9x16" : "3x4")
      : (covers["16x9"] ? "16x9" : "4x3");
  const xCoverRatio = job.x?.coverRatio || xDefaultRatio;
  let xCoverPath = null;
  if (job.x?.coverPath) {
    if (!fs.existsSync(job.x.coverPath)) {
      errors.push(`X 指定封面文件不存在: ${job.x.coverPath}`);
    } else {
      xCoverPath = path.resolve(job.x.coverPath);
    }
  } else if (job.x?.cover16x9 && orientation !== "portrait") {
    if (!fs.existsSync(job.x.cover16x9)) {
      errors.push(`X 指定 16:9 封面文件不存在: ${job.x.cover16x9}`);
    } else {
      xCoverPath = path.resolve(job.x.cover16x9);
    }
  } else if (covers[xCoverRatio]) {
    xCoverPath = covers[xCoverRatio].path;
  } else if (platforms.includes("x")) {
    warnings.push(
      `X（Media Studio）按成片方向（${orientation}）期望 ${xCoverRatio} 封面，但未提供；将保留平台默认抽帧缩略图（不强塞异方向封面）。`
    );
  }

  if (platforms.includes("bilibili") && !job.bilibili?.category) {
    warnings.push("未指定 job.bilibili.category（B 站分区），默认将尝试「人工智能」，建议按成片主旨显式指定。");
  }

  if (errors.length) {
    const err = new Error("任务配置校验未通过:\n- " + errors.join("\n- "));
    err.validationErrors = errors;
    if (activeViewport) err.activeViewport = activeViewport;
    throw err;
  }

  const baseDescription = typeof job.description === "string" ? job.description.trim() : "";
  const baseTopics = Array.isArray(job.topics) ? job.topics.map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean) : [];
  const biliTags = Array.isArray(job.bilibili?.tags) && job.bilibili.tags.length
    ? job.bilibili.tags.map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean)
    : baseTopics;

  const taskName = job.taskName || `五平台草稿 · ${title.slice(0, 18)}`;

  const topicLine = baseTopics.slice(0, 5).map((t) => `#${t}`).join(" ");
  const defaultWechatDesc = baseDescription
    ? [title, baseDescription, topicLine].filter(Boolean).join("\n\n")
    : (topicLine ? `${title} ${topicLine}` : title);

  const hasExplicitLocation =
    Object.prototype.hasOwnProperty.call(job, "location") ||
    (job.xhs && Object.prototype.hasOwnProperty.call(job.xhs, "location")) ||
    (job.douyin && Object.prototype.hasOwnProperty.call(job.douyin, "location")) ||
    (job.wechat && Object.prototype.hasOwnProperty.call(job.wechat, "location"));
  if (!hasExplicitLocation && platforms.some((p) => ["xhs", "douyin", "wechat"].includes(p))) {
    warnings.push(
      "未显式声明 location（小红书/抖音将留空不填，微信视频号将设为「不显示位置」）；地点绝不写死，开工前请先向作者确认本次是否添加地点及具体地标。"
    );
  }

  const topLocation = typeof job.location === "string" ? job.location.trim() : "";
  const topLocationQuery = typeof job.locationQuery === "string" ? job.locationQuery.trim() : "";
  const xhsLoc = resolvePlatformLocation(job.xhs, topLocation, topLocationQuery, false);
  const douyinLoc = resolvePlatformLocation(job.douyin, topLocation, topLocationQuery, false);
  const wechatLoc = resolvePlatformLocation(job.wechat, topLocation, topLocationQuery, true);

  return {
    taskName,
    spaceId: job.spaceId ?? null,
    pageLabels: job.pageLabels || {},
    platforms,
    title,
    description: baseDescription,
    titleMetrics: { xhsWeight, dyLen, biliLen, xLen: [...xTitle].length },
    video: videoMeta,
    covers,
    original,
    aiGenerated: job.aiGenerated,
    allowActivities,
    allowBlackBars,
    location: topLocation,
    topics: baseTopics,
    xhs: {
      title: job.xhs?.title || title,
      description: job.xhs?.description ?? baseDescription,
      topics: job.xhs?.topics || baseTopics.slice(0, 5),
      location: xhsLoc.location,
      locationQuery: xhsLoc.locationQuery,
      videoPath: xhsVideoPath,
      coverRatio: xhsCoverRatio,
      coverPath: covers[xhsCoverRatio]?.path || null,
    },
    douyin: {
      title: job.douyin?.title || title,
      description: job.douyin?.description ?? baseDescription,
      topics: job.douyin?.topics || baseTopics.slice(0, 5),
      location: douyinLoc.location,
      locationQuery: douyinLoc.locationQuery,
      allowContinueExisting: Boolean(job.douyin?.allowContinueExisting),
      cover3x4: covers["3x4"]?.path || null,
      cover4x3: covers["4x3"]?.path || null,
    },
    bilibili: {
      title,
      category: job.bilibili?.category || "人工智能",
      tags: biliTags.slice(0, 10),
      description: job.bilibili?.description ?? baseDescription,
      authDeclaration: job.bilibili?.authDeclaration === true, // 默认不勾选「内容为自制：未经作者允许，禁止转载」
      cover4x3: covers["4x3"]?.path || null,
      cover16x9: covers["16x9"]?.path || null,
    },
    wechat: {
      topics: job.wechat?.topics || baseTopics.slice(0, 5),
      description: job.wechat?.description || defaultWechatDesc,
      shortTitle,
      location: wechatLoc.location,
      locationQuery: wechatLoc.locationQuery,
      cover3x4: covers["3x4"]?.path || null,
      cover4x3: covers["4x3"]?.path || null,
    },
    x: {
      title: xTitle,
      description: job.x?.description || "",
      tweetText: job.x?.tweetText || "",
      videoPath: xVideoPath,
      coverRatio: xCoverRatio,
      coverPath: xCoverPath,
    },
    warnings,
  };
}
