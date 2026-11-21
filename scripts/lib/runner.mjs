import path from "node:path";
import { pathToFileURL } from "node:url";
import { muteAndPausePage, restorePausedUnmuted, spawnUnmutedPage } from "./utils.mjs";
import { XHS_URL, xhsInspectAndInject, xhsFillAndSave, xhsReopenAndVerify } from "./xhs.mjs";
import { DOUYIN_URL, douyinInspectAndInject, douyinFillAndSave, douyinReopenAndVerify } from "./douyin.mjs";
import { BILI_URL, bilibiliInspectAndInject, bilibiliFillAndSave, bilibiliReopenAndVerify } from "./bilibili.mjs";
import { WECHAT_URL, wechatInspectAndInject, wechatFillAndSave, wechatVerifyAndLabel } from "./wechat.mjs";
import { X_URL, xInspectAndInject, xFillAndSave, xVerifyAndCompose } from "./x.mjs";

const PLATFORM_URLS = {
  xhs: XHS_URL,
  douyin: DOUYIN_URL,
  bilibili: BILI_URL,
  wechat: WECHAT_URL,
  x: X_URL,
};

/**
 * 复用已有空间或新建空间；严格遵循规范，绝不擅自接管 ownership === "user" 的其他空间。
 */
async function resolveSpace(ctx, job, mustExist = false) {
  const spaces = await ctx.listTaskSpaces();
  if (job.spaceId != null) {
    const entry = spaces.find((s) => s.id === job.spaceId);
    if (entry) {
      if (entry.ownership === "user") {
        throw new Error(
          `spaceId=${job.spaceId} 当前归属 user（${entry.name}），须先经用户明确同意后再 claimTaskSpace。`
        );
      }
      if (entry.ownership === "agentDelegatedToUser") {
        return ctx.takeOverTaskSpace(job.spaceId);
      }
      return ctx.taskSpace(job.spaceId);
    }
  }
  if (mustExist) {
    throw new Error(`未找到可继续的 TaskSpace (spaceId=${job.spaceId})，请先执行 pass1 或检查 listTaskSpaces()。`);
  }
  const sameName = spaces.find((s) => s.name === job.taskName);
  if (sameName) {
    throw new Error(
      `已存在同名任务空间 id=${sameName.id} (ownership=${sameName.ownership})，请先向用户确认接管或改名，禁止盲目新建重传。`
    );
  }
  return ctx.taskSpace(job.taskName);
}

/**
 * 离线演练：严格遵循 SKILL.md 离线演练步骤，跑完自动 finish({ keep: [] })。
 */
async function runOfflineDrill(ctx, skillRoot) {
  const formUrl = pathToFileURL(path.join(skillRoot, "fixtures", "draft.html")).href;
  const clipPath = path.join(skillRoot, "fixtures", "clip.mp4");
  const coverPath = path.join(skillRoot, "fixtures", "cover-3x4.png");
  const fs = await import("node:fs");
  const clipBytes = fs.statSync(clipPath).size;
  const coverBytes = fs.statSync(coverPath).size;

  const task = await ctx.taskSpace("本机离线演练 · Ego 草稿验证");
  const p1 = task.page("p1");
  try {
    await p1.goto(formUrl, { timeout: 15000 });
    await p1.setInputFiles("#clip", [clipPath]);
    await p1.setInputFiles("#cover", [coverPath]);
    await p1.fill("#title", "Ego 草稿演练");
    await p1.selectOption("#topic", { label: "剪辑教程" });

    await p1.waitForFunction(
      () => {
        const saveBtn = document.querySelector("#save");
        const v = document.querySelector("#preview");
        const img = document.querySelector("#thumbnail");
        return !!saveBtn && !saveBtn.disabled && v?.duration > 0 && img?.naturalWidth > 0;
      },
      undefined,
      { timeout: 10000 }
    );

    const beforeSave = await p1.evaluate(() => {
      const clip = document.querySelector("#clip")?.files?.[0];
      const cover = document.querySelector("#cover")?.files?.[0];
      const v = document.querySelector("#preview");
      const img = document.querySelector("#thumbnail");
      return {
        clipName: clip?.name,
        clipSize: clip?.size,
        duration: v?.duration,
        coverName: cover?.name,
        coverSize: cover?.size,
        coverWidth: img?.naturalWidth,
        coverHeight: img?.naturalHeight,
      };
    });

    await p1.click("#save", { label: "save offline draft" });
    await p1.waitForSelector("#reopen", { state: "visible", timeout: 5000 });
    await p1.reload({ timeout: 15000 });
    await p1.waitForSelector("#reopen", { state: "visible", timeout: 5000 });
    await p1.click("#reopen", { label: "reopen offline draft" });
    await p1.waitForSelector("#details", { state: "visible", timeout: 5000 });

    const details = await p1.evaluate(() => JSON.parse(document.querySelector("#details")?.textContent || "{}"));
    const ok =
      beforeSave.clipSize === clipBytes &&
      beforeSave.coverSize === coverBytes &&
      details.title === "Ego 草稿演练" &&
      details.topic === "剪辑教程" &&
      Math.round(details.video?.duration) === 2 &&
      details.video?.bytes === clipBytes &&
      details.cover?.bytes === coverBytes &&
      details.cover?.width === 240 &&
      details.cover?.height === 320;

    await task.finish({ keep: [] });
    return {
      mode: "本机离线演练",
      ok,
      beforeSave,
      expectedBytes: { clipBytes, coverBytes },
      details,
    };
  } catch (err) {
    await task.finish({ keep: [] }).catch(() => {});
    return { mode: "本机离线演练", ok: false, error: err.message };
  }
}

/**
 * Pass 1：开空间 + 并行打开并验登录 + 并行投递视频 + 静音 + 依次填稿存草稿（五平台独立隔离）。
 */
async function runPass1(ctx, job) {
  const task = await resolveSpace(ctx, job, false);
  const existingPages = await task.pages();
  const pageMap = {};
  const pageLabels = { ...(job.pageLabels || {}) };

  // 为每个目标平台分配或复用标签页：
  // 优先用未占用的 p1（或临时页）作跳板，通过 <a target="_blank"> 生出不带 Ego 内核硬静音的标签页，
  // 全部生完后关闭跳板页；干活期间靠 DOM muteAndPausePage() 保持安静，交接前恢复后用户直接有声播放。
  const assignedLabels = new Set(Object.values(pageLabels).filter(Boolean));
  let launcherPage = null;
  let shouldCloseLauncher = false;
  const needNewCount = job.platforms.filter(
    (key) => !(pageLabels[key] && existingPages.some((p) => p.label === pageLabels[key]))
  ).length;
  if (needNewCount > 0) {
    if (!assignedLabels.has("p1") && existingPages.some((p) => p.label === "p1")) {
      launcherPage = task.page("p1");
      shouldCloseLauncher = true;
    } else {
      launcherPage = await task.newPage();
      shouldCloseLauncher = true;
    }
  }

  for (let i = 0; i < job.platforms.length; i++) {
    const key = job.platforms[i];
    if (pageLabels[key] && existingPages.some((p) => p.label === pageLabels[key])) {
      pageMap[key] = task.page(pageLabels[key]);
    } else {
      const np = await spawnUnmutedPage(task, launcherPage);
      pageMap[key] = np;
      pageLabels[key] = np.label;
    }
  }

  if (shouldCloseLauncher && launcherPage && !Object.values(pageLabels).includes(launcherPage.label)) {
    await launcherPage.close().catch(() => {});
  }

  // 并行导航到各平台入口
  await Promise.all(
    job.platforms.map((key) =>
      pageMap[key].goto(PLATFORM_URLS[key], { timeout: 30000 }).catch((e) => ({ navErr: e.message }))
    )
  );

  // 并行核验登录与注入成片
  const injectHandlers = {
    xhs: xhsInspectAndInject,
    douyin: douyinInspectAndInject,
    bilibili: bilibiliInspectAndInject,
    wechat: wechatInspectAndInject,
    x: xInspectAndInject,
  };
  const injectResults = {};
  await Promise.all(
    job.platforms.map(async (key) => {
      try {
        injectResults[key] = await injectHandlers[key](pageMap[key], job);
      } catch (e) {
        injectResults[key] = { status: "needs_agent_fallback", failedStep: "inject", reason: e.message };
      }
    })
  );

  await Promise.all(job.platforms.map((key) => muteAndPausePage(pageMap[key])));

  // 按黄金顺序执行填稿存草稿：小红书 -> 抖音 -> B 站 -> 微信视频号 -> X（此时转码均已完成）
  const fillOrder = ["xhs", "douyin", "bilibili", "wechat", "x"].filter((k) => job.platforms.includes(k));
  const fillHandlers = {
    xhs: xhsFillAndSave,
    douyin: douyinFillAndSave,
    bilibili: bilibiliFillAndSave,
    wechat: wechatFillAndSave,
    x: xFillAndSave,
  };

  const results = {};
  for (const key of fillOrder) {
    const inj = injectResults[key];
    if (inj?.status !== "injected") {
      results[key] = { inject: inj, status: inj?.status || "needs_agent_fallback" };
      continue;
    }
    const r = await fillHandlers[key](pageMap[key], job);
    results[key] = { inject: inj, ...r };
  }

  const allOk = Object.values(results).every((r) => r.status === "ok");
  return {
    stage: "pass1",
    spaceId: task.spaceId,
    taskName: job.taskName,
    pageLabels,
    allOk,
    nextAction: allOk
      ? "所有平台 Pass 1 均已绿灯存稿，可直接运行 --stage pass2 做统一复开总检。"
      : "存在非 ok 平台：请针对 needs_agent_fallback / needs_user_handoff 的平台单独接管修复后，再运行 --stage pass2。",
    results,
  };
}

/**
 * Pass 2：五平台统一复开总检 + 微信原页设置最终视频标注 + X 核验缩略图进撰写页 + 全页恢复暂停未静音。
 */
async function runPass2(ctx, job) {
  const task = await resolveSpace(ctx, job, true);
  const pageLabels = job.pageLabels || {};
  const results = {};
  const audioRestored = {};

  for (const key of job.platforms) {
    const label = pageLabels[key];
    if (!label) {
      results[key] = { status: "needs_agent_fallback", failedStep: "locate_tab", reason: `缺少 ${key} 的 pageLabel` };
      continue;
    }
    const page = task.page(label);
    if (key === "xhs") results[key] = await xhsReopenAndVerify(page, job);
    else if (key === "douyin") results[key] = await douyinReopenAndVerify(page, job);
    else if (key === "bilibili") results[key] = await bilibiliReopenAndVerify(page, job);
    else if (key === "wechat") results[key] = await wechatVerifyAndLabel(task, page, job);
    else if (key === "x") results[key] = await xVerifyAndCompose(page, job);

    audioRestored[key] = await restorePausedUnmuted(page);
  }

  const tabs = (await task.tabs()).map((t) => ({ label: t.label, title: t.title, url: t.url }));
  const allOk = Object.values(results).every((r) => r.status === "ok");
  return {
    stage: "pass2",
    spaceId: task.spaceId,
    pageLabels,
    allOk,
    nextAction: allOk
      ? "全部验收绿灯且音频已恢复暂停未静音！请写入 local/progress-*.json 后执行 --stage finish 留页交接。"
      : "发现红灯项，请仅针对报错平台精准修补并复核后再执行 --stage finish。",
    results,
    audioRestored,
    tabs,
  };
}

/**
 * 独立 Finish 阶段：仅保留每平台最终编辑页并移交空间控制权给用户。
 */
async function runFinish(ctx, job) {
  const task = await resolveSpace(ctx, job, true);
  const keep = job.platforms.map((k) => job.pageLabels?.[k]).filter(Boolean);
  const tabsBefore = (await task.tabs()).map((t) => ({ label: t.label, title: t.title, url: t.url }));
  await task.finish({ keep });
  return {
    stage: "finish",
    finished: true,
    spaceId: task.spaceId,
    kept: keep,
    tabsBefore,
  };
}

export async function runStage(ctx, payload) {
  if (payload.stage === "offline") return runOfflineDrill(ctx, payload.skillRoot);
  if (payload.stage === "pass1") return runPass1(ctx, payload.job);
  if (payload.stage === "pass2") return runPass2(ctx, payload.job);
  if (payload.stage === "finish") return runFinish(ctx, payload.job);
  throw new Error(`未知 stage: ${payload.stage}`);
}
