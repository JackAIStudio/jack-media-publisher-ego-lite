import { execFileSync } from "node:child_process";
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
      "format=duration,size,bit_rate:format_tags=title,comment",
      "-show_entries",
      "stream=codec_type,codec_name,width,height,display_aspect_ratio:stream_side_data=rotation",
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
    durationSec: Number(Number(info.format?.duration || 0).toFixed(2)),
    sizeBytes: Number(info.format?.size || 0),
    videoCodec: vStream.codec_name || "",
    audioCodec: aStream?.codec_name || "",
    width: displayWidth,
    height: displayHeight,
    rotation,
    orientation,
    tags: info.format?.tags || {},
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

const VALID_PLATFORMS = ["xhs", "douyin", "bilibili", "wechat"];

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
  if (platforms.includes("douyin") && dyLen > 30) {
    errors.push(`抖音标题字数为 ${dyLen}/30（超限）。`);
  }
  if (platforms.includes("bilibili") && biliLen > 80) {
    errors.push(`B 站标题字数为 ${biliLen}/80（超限）。`);
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

  // 探测成片
  let videoMeta = null;
  if (!job.video) {
    errors.push("缺少必填字段 video（本地成片绝对路径）。");
  } else if (!fs.existsSync(job.video)) {
    errors.push(`本地成片不存在: ${job.video}`);
  } else if (!options.skipProbe) {
    videoMeta = probeVideo(job.video);
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
  for (const key of ["3x4", "4x3", "16x9"]) {
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

  if (platforms.includes("bilibili") && !job.bilibili?.category) {
    warnings.push("未指定 job.bilibili.category（B 站分区），默认将尝试「人工智能」，建议按成片主旨显式指定。");
  }

  if (errors.length) {
    const err = new Error("任务配置校验未通过:\n- " + errors.join("\n- "));
    err.validationErrors = errors;
    throw err;
  }

  const baseTopics = Array.isArray(job.topics) ? job.topics.map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean) : [];
  const biliTags = Array.isArray(job.bilibili?.tags) && job.bilibili.tags.length
    ? job.bilibili.tags.map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean)
    : baseTopics;

  const taskName = job.taskName || `四平台草稿 · ${title.slice(0, 18)}`;

  return {
    taskName,
    spaceId: job.spaceId ?? null,
    pageLabels: job.pageLabels || {},
    platforms,
    title,
    titleMetrics: { xhsWeight, dyLen, biliLen },
    video: videoMeta,
    covers,
    original,
    aiGenerated: job.aiGenerated,
    topics: baseTopics,
    xhs: {
      title: job.xhs?.title || title,
      topics: job.xhs?.topics || baseTopics.slice(0, 5),
      coverRatio: xhsCoverRatio,
      coverPath: covers[xhsCoverRatio]?.path || null,
    },
    douyin: {
      title,
      topics: job.douyin?.topics || baseTopics.slice(0, 5),
      allowContinueExisting: Boolean(job.douyin?.allowContinueExisting),
      cover3x4: covers["3x4"]?.path || null,
      cover4x3: covers["4x3"]?.path || null,
    },
    bilibili: {
      title,
      category: job.bilibili?.category || "人工智能",
      tags: biliTags.slice(0, 10),
      description: job.bilibili?.description || "",
      cover4x3: covers["4x3"]?.path || null,
      cover16x9: covers["16x9"]?.path || null,
    },
    wechat: {
      topics: job.wechat?.topics || baseTopics.slice(0, 5),
      description:
        job.wechat?.description ||
        (baseTopics.length
          ? `${title} ${baseTopics.slice(0, 5).map((t) => `#${t}`).join(" ")}`
          : title),
      shortTitle,
      location: job.wechat?.location || "不显示位置",
      cover3x4: covers["3x4"]?.path || null,
      cover4x3: covers["4x3"]?.path || null,
    },
    warnings,
  };
}
