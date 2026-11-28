import path from "node:path";
import {
  bringToFront,
  calcUploadTimeoutMs,
  collectLightDiagnostics,
  isDurationMatch,
  makeFallback,
  makeHandoff,
  muteAndPausePage,
} from "./utils.mjs";

export const X_URL = "https://studio.x.com/library";

/**
 * 阶段 1a：核验 X Media Studio 登录态，并启动视频原片上传。
 */
export async function xInspectAndInject(page, job) {
  await bringToFront(page);
  await page.waitForTimeout(3000);

  const pre = await page.evaluate(() => {
    const t = (document.body?.innerText || "").replace(/\s+/g, " ");
    return {
      url: location.href,
      hasUploadBtn: t.includes("上传媒体") || t.includes("Upload media"),
      needLogin:
        location.href.includes("/login") ||
        location.href.includes("/flow/login") ||
        t.includes("登录 X") ||
        t.includes("Sign in to X"),
      snippet: t.slice(0, 260),
    };
  });

  if (pre.needLogin || !pre.hasUploadBtn) {
    return makeHandoff("login", "X Media Studio 未登录或会话已失效，需要 Jack 登录后继续", { pre });
  }

  const videoPath = job.x.videoPath || job.video.path;
  try {
    const chooserPromise = page.waitForFileChooser({ timeout: 10000 });
    await page.click('button:has-text("上传媒体")', { label: "upload video to X Media Studio" });
    const chooser = await chooserPromise;
    await chooser.setFiles(videoPath);
  } catch (err) {
    return makeFallback("inject", `X Media Studio 启动视频上传失败: ${err.message}`, await collectLightDiagnostics(page));
  }

  await page.waitForTimeout(2000);
  await muteAndPausePage(page);

  return {
    status: "injected",
    videoPath,
    fileName: path.basename(videoPath),
  };
}

/**
 * 阶段 1b：等待视频处理完成 -> 进入 /library/<mediaKey>/edit -> 填标题（说明默认留空）-> 两步法上传与成片方向匹配的缩略图。
 */
export async function xFillAndSave(page, job) {
  let step = "wait_upload";
  try {
    await bringToFront(page);
    await muteAndPausePage(page);

    const fileName = path.basename(job.x.videoPath || job.video.path);
    const expectedDurSec = Number(job.video?.durationSec || 0);
    const uploadTimeoutMs = calcUploadTimeoutMs(job.video?.sizeBytes, 180000, 360000);
    const start = Date.now();
    let itemReady = false;
    let lastWindow = "";
    while (Date.now() - start < uploadTimeoutMs) {
      const st = await page.evaluate((fn) => {
        const t = (document.body?.innerText || "").replace(/\s+/g, " ");
        const idx = t.indexOf(fn);
        const win = idx >= 0 ? t.slice(Math.max(0, idx - 60), idx + 120) : t.slice(0, 260);
        const uploading = /正在载入|正在上传|正在处理|处理中|Uploading|Processing|\d+%/.test(win);
        return { found: idx >= 0, uploading, win };
      }, fileName);
      lastWindow = st.win;
      if (st.found && !st.uploading) {
        itemReady = true;
        break;
      }
      await page.waitForTimeout(3000);
    }

    if (!itemReady) {
      return makeFallback("wait_upload", `X Media Studio 等待 ${fileName} 上传完成超时`, await collectLightDiagnostics(page), {
        lastWindow,
      });
    }

    // 优先通过 /1/library/list.json 按「文件名 + 时长 + 未发帖」精准锁定本条 media_key，
    // 防止上传间隙作者并发发布其他视频或媒体库存在历史同名文件（如多个 v2.mov）导致误选错稿！
    step = "open_detail";
    const apiMatch = await page.evaluate(
      async ({ fn, expDur }) => {
        const csrf = (document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/) || [])[1] || "";
        const uid = (document.cookie.match(/(?:^|;\s*)twid=u%3D(\d+)/) || [])[1] || "";
        const res = await fetch(`/1/library/list.json?user_id=${uid}&count=10`, {
          credentials: "include",
          headers: {
            "x-csrf-token": csrf,
            "x-twitter-active-user": "yes",
            "x-twitter-auth-type": "OAuth2Session",
          },
        });
        if (!res.ok) return { ok: false, status: res.status };
        let parsed = null;
        try {
          parsed = await res.json();
        } catch {
          return { ok: false, parseError: true };
        }
        const rows = (parsed?.results || []).map((item) => {
          const durMs = Number(item?.content?.duration || 0);
          return {
            mediaKey: item?.media_key || null,
            filename: item?.metadata?.filename || item?.metadata?.name || "",
            title: item?.metadata?.title || "",
            tweeted: !!item?.metadata?.tweeted,
            durSec: durMs > 0 ? Number((durMs / 1000).toFixed(2)) : null,
            created: item?.metadata?.time_created || "",
          };
        });
        const durOk = (d) => {
          if (!expDur || !d) return true;
          const tol = Math.max(4, expDur * 0.1);
          return Math.abs(d - expDur) <= tol;
        };
        const exactUntweeted = rows.find((r) => r.mediaKey && !r.tweeted && r.filename === fn && durOk(r.durSec));
        const exactAny = rows.find((r) => r.mediaKey && r.filename === fn && durOk(r.durSec));
        const untweetedDur = rows.find((r) => r.mediaKey && !r.tweeted && durOk(r.durSec) && !r.title);
        const picked = exactUntweeted || exactAny || untweetedDur || null;
        return {
          ok: !!picked,
          picked,
          matchedBy: exactUntweeted ? "untweeted+filename+duration" : exactAny ? "filename+duration" : untweetedDur ? "untweeted+duration" : null,
          topRows: rows.slice(0, 5),
        };
      },
      { fn: fileName, expDur: expectedDurSec }
    );

    let mediaKey = apiMatch?.picked?.mediaKey || null;
    let editUrl = "";
    if (mediaKey) {
      await page.goto(`https://studio.x.com/library/${mediaKey}/edit`, { timeout: 30000 });
      await page.waitForSelector('input[name="media.metadata.title"]', { state: "visible", timeout: 20000 }).catch(() => {});
      await muteAndPausePage(page);
      editUrl = await page.evaluate(() => location.href);
      mediaKey = editUrl.match(/\/library\/([^/?#]+)\/edit/)?.[1] || null;
    } else {
      // 仅在 list.json 无法命中时才回退点击页面卡片，且回读校验时长防止点错历史同名文件
      const clickPos = await page.evaluate((fn) => {
        const el = [...document.querySelectorAll("div, span, p, h1, h2, h3, h4, a")].find(
          (n) => (n.textContent || "").trim() === fn
        );
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }, fileName);
      if (!clickPos) {
        return makeFallback("open_detail", `未在媒体库列表中精准匹配到 ${fileName} (约 ${expectedDurSec}s)`, await collectLightDiagnostics(page), {
          apiMatch,
        });
      }
      await page.mouse.click(clickPos.x, clickPos.y, { label: "open X media detail" });
      await page.waitForTimeout(2500);
      await muteAndPausePage(page);
      editUrl = await page.evaluate(() => location.href);
      mediaKey = editUrl.match(/\/library\/([^/?#]+)\/edit/)?.[1] || null;
    }

    if (!mediaKey) {
      return makeFallback("open_detail", `未能进入目标视频的 /library/<mediaKey>/edit (${editUrl})`, await collectLightDiagnostics(page), {
        apiMatch,
      });
    }

    step = "metadata";
    await page.click('input[name="media.metadata.title"]', { label: "focus X media title input" });
    await page.fill('input[name="media.metadata.title"]', job.x.title);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(400);
    if (job.x.description) {
      await page.fill('textarea[name="media.metadata.description"]', job.x.description);
      await page.keyboard.press("Tab");
      await page.waitForTimeout(300);
    }
    await page.evaluate(() => {
      const el = document.querySelector('input[name="media.metadata.title"]');
      el?.dispatchEvent(new Event("change", { bubbles: true }));
      el?.blur();
    });
    await page.waitForTimeout(1000);

    step = "thumbnail";
    let thumbUploaded = false;
    const xCoverPath = job.x.coverPath || job.x.cover16x9 || null;
    if (xCoverPath) {
      await page.click('button:has-text("更改缩略图")', { label: "open X thumbnail selector" });
      await page.waitForTimeout(1000);
      const chooserPromise = page.waitForFileChooser({ timeout: 10000 });
      await page.click('a:text-is("上传")', { label: "click X thumbnail upload link" });
      const chooser = await chooserPromise;
      await chooser.setFiles(xCoverPath);
      await page.waitForTimeout(5500);
      thumbUploaded = true;
    }

    const hasSave = await page.evaluate(() =>
      [...document.querySelectorAll("button")].some(
        (b) => (b.innerText || "").trim() === "保存" && !b.disabled && b.getBoundingClientRect().height > 0
      )
    );
    if (hasSave) {
      await page.click('button:text-is("保存")', { label: "save X media metadata" });
      await page.waitForTimeout(2500);
    }

    // 回读 /1/library/get.json 确认标题、时长与自定义缩略图确实已落盘到本条 mediaKey
    step = "save_verify";
    let saveCheck = null;
    const vt0 = Date.now();
    while (Date.now() - vt0 < 20000) {
      saveCheck = await page.evaluate(async (mk) => {
        const csrf = (document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/) || [])[1] || "";
        const uid = (document.cookie.match(/(?:^|;\s*)twid=u%3D(\d+)/) || [])[1] || "";
        const res = await fetch(`/1/library/get.json?user_id=${uid}&media_key=${mk}`, {
          credentials: "include",
          headers: {
            "x-csrf-token": csrf,
            "x-twitter-active-user": "yes",
            "x-twitter-auth-type": "OAuth2Session",
          },
        });
        const text = await res.text();
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {}
        const meta = parsed?.result?.metadata || parsed?.metadata || null;
        const content = parsed?.result?.content || parsed?.content || null;
        const previewSrc = content?.preview?.source || "";
        return {
          status: res.status,
          title: meta?.title ?? null,
          description: meta?.description ?? "",
          durSec: content?.duration ? Number((Number(content.duration) / 1000).toFixed(2)) : null,
          hasMediaThumb: /https:\/\/pbs\.twimg\.com\/media\//.test(previewSrc || text),
        };
      }, mediaKey);
      if (
        saveCheck.status === 200 &&
        saveCheck.title === job.x.title &&
        (!xCoverPath || saveCheck.hasMediaThumb)
      ) {
        break;
      }
      await page.waitForTimeout(2000);
    }

    if (saveCheck?.durSec && expectedDurSec && !isDurationMatch(saveCheck.durSec, expectedDurSec)) {
      return makeFallback(
        "save_verify",
        `X 媒体时长不符（mediaKey=${mediaKey} 实读 ${saveCheck.durSec}s，期望 ${expectedDurSec}s），疑似定位到错误视频`,
        await collectLightDiagnostics(page),
        { mediaKey, saveCheck }
      );
    }

    return {
      status: "ok",
      mediaKey,
      matchedBy: apiMatch?.matchedBy || "card_click",
      editUrl,
      thumbUploaded,
      saveCheck,
    };
  } catch (err) {
    return makeFallback(step, `X Media Studio 填稿失败: ${err.message}`, await collectLightDiagnostics(page));
  }
}

/**
 * 阶段 2：通过 /1/library/get.json 核验标题、说明与同方向自定义缩略图，然后直达 /compose 撰写页留空交接。
 * 硬边界：绝不点击「帖子」发送按钮或「预排期帖子」。
 */
export async function xVerifyAndCompose(page, job) {
  let step = "verify_api";
  try {
    await bringToFront(page);
    await muteAndPausePage(page);

    const curUrl = await page.evaluate(() => location.href);
    const mediaKey = curUrl.match(/\/library\/([^/?#]+)\/(?:edit|compose)/)?.[1] || null;
    if (!mediaKey) {
      return makeFallback("locate_media", `当前 X 标签页未处于媒体详情或撰写页 (${curUrl})`, await collectLightDiagnostics(page));
    }

    const xCoverPath = job.x.coverPath || job.x.cover16x9 || null;
    let apiVerify = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      apiVerify = await page.evaluate(async (mk) => {
        const csrf = (document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/) || [])[1] || "";
        const uid = (document.cookie.match(/(?:^|;\s*)twid=u%3D(\d+)/) || [])[1] || "";
        const res = await fetch(`/1/library/get.json?user_id=${uid}&media_key=${mk}`, {
          credentials: "include",
          headers: {
            "x-csrf-token": csrf,
            "x-twitter-active-user": "yes",
            "x-twitter-auth-type": "OAuth2Session",
          },
        });
        const text = await res.text();
        const mediaThumb = (text.match(/https:\/\/pbs\.twimg\.com\/media\/[^"\\]+/) || [])[0] || null;
        const ampThumb = (text.match(/https:\/\/pbs\.twimg\.com\/amplify_video_thumb\/[^"\\]+/) || [])[0] || null;
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {}
        const meta = parsed?.result?.metadata || parsed?.metadata || parsed?.media?.metadata || null;
        const content = parsed?.result?.content || parsed?.content || null;
        const durMs = Number(content?.duration || 0);
        return {
          status: res.status,
          mediaThumb,
          ampThumb,
          title: meta?.title ?? (text.match(/"title":"([^"]*)"/) || [])[1] ?? null,
          description: meta?.description ?? (text.match(/"description":"([^"]*)"/) || [])[1] ?? "",
          durSec: durMs > 0 ? Number((durMs / 1000).toFixed(2)) : null,
        };
      }, mediaKey);
      if (!xCoverPath || apiVerify.mediaThumb) break;
      await page.waitForTimeout(2000);
    }

    const issues = [];
    if (apiVerify?.status !== 200) issues.push(`/1/library/get.json 返回异常 status=${apiVerify?.status}`);
    if (apiVerify?.durSec && job.video?.durationSec && !isDurationMatch(apiVerify.durSec, job.video.durationSec)) {
      issues.push(
        `X 视频时长不符（mediaKey=${mediaKey} 实读 ${apiVerify.durSec}s，期望约 ${job.video.durationSec}s，疑似错选媒体）`
      );
    }
    if (apiVerify?.title !== job.x.title) issues.push(`标题不一致: "${apiVerify?.title}"`);
    if (!job.x.description && apiVerify?.description) {
      issues.push(`说明默认应留空，实读非空: "${apiVerify.description}"`);
    }
    if (xCoverPath && !apiVerify?.mediaThumb) {
      issues.push(`自定义 ${job.x.coverRatio || ""} 缩略图尚未生效为 pbs.twimg.com/media/...`);
    }

    step = "open_compose";
    const composeUrl = `https://studio.x.com/library/${mediaKey}/compose`;
    if (!curUrl.includes(`/library/${mediaKey}/compose`)) {
      await page.goto(composeUrl, { timeout: 30000 });
      await page.waitForTimeout(2500);
    }
    await muteAndPausePage(page);

    if (job.x.tweetText) {
      const existingText = await page.evaluate(() => document.querySelector("textarea")?.value || "");
      if (!existingText.trim()) {
        await page.fill("textarea", job.x.tweetText);
        await page.waitForTimeout(300);
      }
    }

    const composeCheck = await page.evaluate(() => {
      const ta = document.querySelector("textarea");
      return {
        url: location.href,
        hasTextarea: !!ta,
        placeholder: ta?.placeholder || "",
        textVal: ta?.value || "",
      };
    });
    if (!composeCheck.hasTextarea) {
      issues.push("撰写页未检测到推文输入框 textarea");
    }

    return {
      status: issues.length ? "needs_agent_fallback" : "ok",
      failedStep: issues.length ? "verify" : null,
      issues,
      mediaKey,
      verified: {
        title: apiVerify?.title,
        description: apiVerify?.description,
        hasCustomMediaThumb: !!apiVerify?.mediaThumb,
        mediaThumbHost: apiVerify?.mediaThumb ? "pbs.twimg.com/media" : null,
        compose: composeCheck,
      },
    };
  } catch (err) {
    return makeFallback(step, `X Media Studio 复核撰写页失败: ${err.message}`, await collectLightDiagnostics(page));
  }
}
