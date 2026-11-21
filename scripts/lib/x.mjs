import path from "node:path";
import { bringToFront, collectLightDiagnostics, makeFallback, makeHandoff, muteAndPausePage } from "./utils.mjs";

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
 * 阶段 1b：等待视频处理完成 -> 进入 /library/<mediaKey>/edit -> 填标题（说明默认留空）-> 两步法上传 16:9 缩略图。
 */
export async function xFillAndSave(page, job) {
  let step = "wait_upload";
  try {
    await bringToFront(page);
    await muteAndPausePage(page);

    const fileName = path.basename(job.x.videoPath || job.video.path);
    const start = Date.now();
    let itemReady = false;
    let lastWindow = "";
    while (Date.now() - start < 120000) {
      const st = await page.evaluate((fn) => {
        const t = (document.body?.innerText || "").replace(/\s+/g, " ");
        const idx = t.indexOf(fn);
        const win = idx >= 0 ? t.slice(Math.max(0, idx - 60), idx + 120) : t.slice(0, 260);
        const uploading = /正在载入|正在上传|处理中|Uploading|Processing|\d+%/.test(win);
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

    step = "open_detail";
    const clickPos = await page.evaluate((fn) => {
      const el = [...document.querySelectorAll("div, span, p, h1, h2, h3, h4, a")].find(
        (n) => (n.textContent || "").trim() === fn
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }, fileName);
    if (!clickPos) {
      return makeFallback("open_detail", `未在媒体库列表中定位到 ${fileName}`, await collectLightDiagnostics(page));
    }

    await page.mouse.click(clickPos.x, clickPos.y, { label: "open X media detail" });
    await page.waitForTimeout(2500);
    await muteAndPausePage(page);

    const editUrl = await page.evaluate(() => location.href);
    const mediaKeyMatch = editUrl.match(/\/library\/([^/?#]+)\/edit/);
    const mediaKey = mediaKeyMatch?.[1] || null;
    if (!mediaKey) {
      return makeFallback("open_detail", `点击媒体卡片后未进入 /library/<mediaKey>/edit (${editUrl})`, await collectLightDiagnostics(page));
    }

    step = "metadata";
    await page.fill('input[name="media.metadata.title"]', job.x.title);
    await page.waitForTimeout(250);
    if (job.x.description) {
      await page.fill('textarea[name="media.metadata.description"]', job.x.description);
      await page.waitForTimeout(250);
    }
    await page.evaluate(() => {
      const el = document.querySelector('input[name="media.metadata.title"]');
      el?.dispatchEvent(new Event("change", { bubbles: true }));
      el?.blur();
    });
    await page.waitForTimeout(800);

    step = "thumbnail";
    let thumbUploaded = false;
    if (job.x.cover16x9) {
      await page.click('button:has-text("更改缩略图")', { label: "open X thumbnail selector" });
      await page.waitForTimeout(1000);
      const chooserPromise = page.waitForFileChooser({ timeout: 10000 });
      await page.click('a:text-is("上传")', { label: "click X thumbnail upload link" });
      const chooser = await chooserPromise;
      await chooser.setFiles(job.x.cover16x9);
      await page.waitForTimeout(4500);
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

    return {
      status: "ok",
      mediaKey,
      editUrl,
      thumbUploaded,
    };
  } catch (err) {
    return makeFallback(step, `X Media Studio 填稿失败: ${err.message}`, await collectLightDiagnostics(page));
  }
}

/**
 * 阶段 2：通过 /1/library/get.json 核验标题、说明与 16:9 自定义缩略图，然后直达 /compose 撰写页留空交接。
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
        return {
          status: res.status,
          mediaThumb,
          ampThumb,
          title: meta?.title ?? (text.match(/"title":"([^"]*)"/) || [])[1] ?? null,
          description: meta?.description ?? (text.match(/"description":"([^"]*)"/) || [])[1] ?? "",
        };
      }, mediaKey);
      if (!job.x.cover16x9 || apiVerify.mediaThumb) break;
      await page.waitForTimeout(2000);
    }

    const issues = [];
    if (apiVerify?.status !== 200) issues.push(`/1/library/get.json 返回异常 status=${apiVerify?.status}`);
    if (apiVerify?.title !== job.x.title) issues.push(`标题不一致: "${apiVerify?.title}"`);
    if (!job.x.description && apiVerify?.description) {
      issues.push(`说明默认应留空，实读非空: "${apiVerify.description}"`);
    }
    if (job.x.cover16x9 && !apiVerify?.mediaThumb) {
      issues.push("自定义 16:9 缩略图尚未生效为 pbs.twimg.com/media/...");
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
