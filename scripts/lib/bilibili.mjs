import {
  bringToFront,
  collectLightDiagnostics,
  makeFallback,
  makeHandoff,
  muteAndPausePage,
} from "./utils.mjs";

export const BILI_URL = "https://member.bilibili.com/platform/upload/video/frame";
export const BILI_DRAFT_URL = "https://member.bilibili.com/platform/upload-manager/article?group=draft";

/**
 * 阶段 1a：带 credentials:"include" 核验真实登录态（防假在线），再精准向 .bcc-upload-wrapper 视频框注入成片。
 */
export async function bilibiliInspectAndInject(page, job) {
  await page
    .waitForSelector('.bcc-upload-wrapper input[type="file"]', { state: "attached", timeout: 15000 })
    .catch(() => {});

  const nav = await page
    .fetch("https://api.bilibili.com/x/web-interface/nav", { credentials: "include" })
    .then((r) => {
      try {
        const j = JSON.parse(r.body);
        return { isLogin: !!j?.data?.isLogin, uname: j?.data?.uname || "", mid: j?.data?.mid || null, code: j?.code };
      } catch {
        return { isLogin: false, status: r.status };
      }
    })
    .catch((e) => ({ isLogin: false, err: e.message }));

  if (!nav.isLogin) {
    return makeHandoff("login", "B 站登录会话无效或已过期（nav isLogin !== true），请先扫码登录。", { nav });
  }

  const inputs = await page.evaluate(() =>
    [...document.querySelectorAll('input[type="file"]')].map((el, i) => ({
      i,
      accept: el.accept || "",
      inBcc: !!el.closest(".bcc-upload-wrapper"),
    }))
  );
  const idx = inputs.findIndex(
    (x) => x.inBcc && (x.accept.includes("mp4") || x.accept.includes("video") || x.accept === "")
  );
  const sel = idx >= 0 ? `input[type="file"] >> nth=${idx}` : '.bcc-upload-wrapper input[type="file"] >> nth=0';
  await page.setInputFiles(sel, [job.video.path]);
  return { status: "injected", account: `${nav.uname} (mid:${nav.mid})` };
}

/**
 * 阶段 1b：填标题、选分区、清自动无关标签并加目标标签、设创作声明与自制授权、传 4:3+16:9 双封面（拒同步）、存草稿。
 */
export async function bilibiliFillAndSave(page, job) {
  let step = "wait_editor";
  try {
    await bringToFront(page);
    await page.waitForSelector('input.input-val[placeholder*="稿件标题"]', { state: "visible", timeout: 25000 });
    await muteAndPausePage(page);

    // 1. 标题
    step = "title";
    await page.fill('input.input-val[placeholder*="稿件标题"]', job.bilibili.title);
    await page.waitForTimeout(250);

    // 2. 分区
    step = "category";
    await page.evaluate(() => document.querySelector(".select-controller")?.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(250);
    await page.click(".select-controller", { label: "open Bili category" });
    await page.waitForTimeout(450);
    const catPicked = await page.evaluate((catName) => {
      const container =
        document.querySelector(".drop-list-v2-container.human-type-list") ||
        document.querySelector(".drop-list-v2-container");
      const items = [...(container?.querySelectorAll(".drop-list-v2-item") || [])];
      const target = items.find((el) => (el.querySelector(".item-cont-main")?.textContent?.trim() || "") === catName);
      if (target) target.click();
      return { found: !!target, totalOpts: items.length };
    }, job.bilibili.category);
    if (!catPicked.found) throw new Error(`B 站分区下拉未找到「${job.bilibili.category}」`);
    await page.waitForTimeout(350);

    // 3. 清理自动无关标签（鼠标点击关闭按钮，绝不空框按 Backspace）+ 填目标标签
    step = "tags";
    const tagInputSel = 'input.input-val[placeholder*="回车键Enter"]';
    await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "center" }), tagInputSel);
    await page.waitForTimeout(250);

    const removedAutoTags = [];
    for (let guard = 0; guard < 12; guard++) {
      const target = await page.evaluate((wanted) => {
        for (const c of document.querySelectorAll(".label-item-v2-container")) {
          const txt = c.querySelector(".label-item-v2-content")?.textContent?.trim() || "";
          if (!wanted.includes(txt)) {
            c.scrollIntoView({ block: "center" });
            const closeEl = c.querySelector('.label-item-v2-close, [class*="close"], svg');
            const clickable =
              (closeEl?.closest("span, i, div") !== c ? closeEl?.closest("span, i, div") : closeEl) || closeEl;
            const r = clickable?.getBoundingClientRect();
            if (r && r.width > 0) {
              return { txt, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
          }
        }
        return null;
      }, job.bilibili.tags);
      if (!target) break;
      await page.mouse.click(target.x, target.y, { label: `remove Bili auto tag ${target.txt}` });
      removedAutoTags.push(target.txt);
      await page.waitForTimeout(300);
    }

    for (const tag of job.bilibili.tags) {
      await page.fill(tagInputSel, tag);
      await page.waitForTimeout(120);
      await page.press(tagInputSel, "Enter");
      await page.waitForTimeout(280);
    }
    const tagsAfter = await page.evaluate(() =>
      [...document.querySelectorAll(".label-item-v2-content")].map((el) => el.textContent?.trim())
    );
    const missingTags = job.bilibili.tags.filter((t) => !tagsAfter.includes(t));

    // 4. 创作声明 + 自制授权
    step = "declarations";
    const targetDecl = job.aiGenerated ? "含AI生成内容" : "内容无需标注";
    await page.evaluate(() =>
      document.querySelector("input.bcc-select-input-inner")?.scrollIntoView({ block: "center" })
    );
    await page.waitForTimeout(250);
    await page.click("input.bcc-select-input-inner", { label: "open Bili creation declaration" });
    await page.waitForTimeout(500);

    const declClicked = await page.evaluate((target) => {
      const opt = [...document.querySelectorAll(".bcc-option")].find((el) => (el.innerText || "").trim() === target);
      if (opt) {
        opt.click();
        return true;
      }
      return false;
    }, targetDecl);
    if (!declClicked) throw new Error(`未在 B 站创作声明下拉中找到「${targetDecl}」`);
    await page.waitForTimeout(400);

    if (job.original) {
      const authVis = await page.evaluate(() => {
        const a = document.querySelector(".auth-content");
        return !!(a && a.getBoundingClientRect().height > 0);
      });
      if (!authVis) {
        await page.click("input.bcc-select-input-inner", { label: "reopen Bili decl for auth" });
        await page.waitForTimeout(400);
      }
      await page.evaluate(() => {
        const auth = document.querySelector(".auth-content");
        if (!auth) return;
        const already =
          auth.className.includes("selected") ||
          !!auth.querySelector(".option-text-selected") ||
          (auth.parentElement?.className || "").includes("selected");
        if (!already) auth.click();
      });
      await page.waitForTimeout(350);
    }
    await page.evaluate(() => document.body.click());
    await page.waitForTimeout(300);

    // 5. 双封面：兼容空槽 (.cover-empty-pill) 与已抽帧更改封面入口，严格核对 parentElement active token
    step = "covers";
    let coverLog = {};
    if (job.bilibili.cover4x3 || job.bilibili.cover16x9) {
      await page.evaluate(() => document.querySelector(".cover-content")?.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(350);
      const triggerRect = await page.evaluate(() => {
        const textBtn = [...document.querySelectorAll(".cover-content span, .cover-content div, .cover-content button")].find(
          (n) => {
            const t = (n.innerText || "").trim();
            return (t === "更改封面" || t === "上传封面") && n.getBoundingClientRect().width > 0;
          }
        );
        const el =
          textBtn ||
          document.querySelector(".cover-content .cover-empty-pill") ||
          document.querySelector(".cover-content .cover-slot") ||
          document.querySelector(".cover-content .cover-main");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      if (!triggerRect) throw new Error("未找到 B 站封面编辑触发入口");
      await page.mouse.click(triggerRect.x, triggerRect.y, { label: "open Bili cover editor" });
      await page.waitForTimeout(1600);

      // 若出现「智能生成封面」先点「不使用」
      const skippedSmart = await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button, div, span")].find(
          (el) => (el.innerText || "").trim() === "不使用" && el.getBoundingClientRect().height > 0
        );
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (skippedSmart) await page.waitForTimeout(1000);
      await page.waitForSelector("#editor_4_3", { state: "visible", timeout: 10000 });

      const coverInputSel = await page.evaluate(() => {
        const inps = [...document.querySelectorAll('input[type="file"]')];
        const idx = inps.findIndex((i) => (i.accept || "").includes("image"));
        return idx >= 0 ? `input[type="file"] >> nth=${idx}` : null;
      });
      if (!coverInputSel) throw new Error("未找到 B 站封面编辑器图片上传框");

      // 4:3 首页推荐封面
      if (job.bilibili.cover4x3) {
        const a43 = await page.evaluate(() =>
          (document.querySelector("#editor_4_3")?.parentElement?.className || "").split(/\s+/).includes("active")
        );
        if (!a43) {
          await page.click("#editor_4_3", { label: "activate Bili 4:3 panel" });
          await page.waitForTimeout(450);
        }
        await page.setInputFiles(coverInputSel, [job.bilibili.cover4x3]);
        await page.waitForTimeout(2300);
        coverLog.uploaded43 = true;
      }

      // 16:9 个人空间封面（严格校验 parentElement active token）
      if (job.bilibili.cover16x9) {
        const r169 = await page.evaluate(() => {
          const el = document.querySelector("#editor_16_9");
          const r = el?.getBoundingClientRect();
          return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
        });
        if (r169) {
          await page.mouse.click(r169.x, r169.y, { label: "activate Bili 16:9 panel" });
          await page.waitForTimeout(600);
        }
        let a169 = await page.evaluate(() =>
          (document.querySelector("#editor_16_9")?.parentElement?.className || "").split(/\s+/).includes("active")
        );
        if (!a169) {
          await page.click('text="个人空间封面（16:9）"', { label: "click Bili 16:9 title" }).catch(() => {});
          await page.waitForTimeout(500);
          a169 = await page.evaluate(() =>
            (document.querySelector("#editor_16_9")?.parentElement?.className || "").split(/\s+/).includes("active")
          );
        }
        if (!a169) throw new Error("B 站 16:9 面板未能切换为 active，已中止防止错槽覆盖");
        await page.setInputFiles(coverInputSel, [job.bilibili.cover16x9]);
        await page.waitForTimeout(2300);
        coverLog.uploaded169 = true;
      }

      // 完成并拒绝同步覆盖
      await page.click("div.button.submit", { label: "confirm Bili dual covers" });
      await page.waitForTimeout(1200);
      coverLog.refusedSync = await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button, div, span")].find((el) => {
          const t = (el.innerText || "").trim();
          return t.includes("不同步") && el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().height < 60;
        });
        if (btn) {
          btn.click();
          return btn.innerText.trim();
        }
        return null;
      });
      await page.waitForTimeout(2300);
    }

    // 6. 等上传完成并点「存草稿」
    step = "save_draft";
    await page
      .waitForFunction(() => (document.body?.innerText || "").includes("上传完成"), undefined, { timeout: 25000 })
      .catch(() => {});
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("span, div, button")].find(
        (el) => el.children.length === 0 && (el.textContent || "").trim() === "存草稿"
      );
      (btn?.parentElement || btn)?.scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(300);
    await page.click('text="存草稿"', { label: "save Bili draft" });
    await page.waitForTimeout(3500);

    const afterSave = await page.evaluate(() => ({
      url: location.href,
      hasDraftList: location.href.includes("group=draft") || (document.body?.innerText || "").includes("草稿"),
    }));
    if (!afterSave.hasDraftList) {
      return makeFallback("save_draft", "B 站点击存草稿后未跳转到草稿箱", await collectLightDiagnostics(page), {
        removedAutoTags,
        tagsAfter,
        missingTags,
        coverLog,
        afterSave,
      });
    }

    return { status: "ok", removedAutoTags, tagsAfter, missingTags, coverLog, afterSave };
  } catch (err) {
    return makeFallback(step, err, await collectLightDiagnostics(page));
  }
}

/**
 * 阶段 2：从「稿件管理 -> 草稿」复开目标稿件，核对全部字段与双封面真实像素/独立 URL。
 */
export async function bilibiliReopenAndVerify(page, job) {
  let step = "reopen";
  try {
    await bringToFront(page);
    if (!(await page.url()).includes("group=draft")) {
      await page.goto(BILI_DRAFT_URL, { timeout: 20000 });
      await page.waitForTimeout(2500);
    }

    const fullTitle = job.bilibili.title;
    const titlePrefix = fullTitle.slice(0, 10);
    const reopen = await page.evaluate(
      ({ full, prefix }) => {
        const rows = [...document.querySelectorAll('.article-card, .draft-item, [class*="card"], [class*="item"], li, div')];
        const parseRows = (needle) =>
          rows
            .map((r) => {
              const t = (r.innerText || "").replace(/\s+/g, " ");
              const btn = [...r.querySelectorAll("a, button, span, div")].find(
                (el) => (el.textContent || "").trim() === "编辑"
              );
              const dm = t.match(/(\d{4})年(\d{2})月(\d{2})日\s+(\d{2}:\d{2}:\d{2})/);
              const ts = dm ? `${dm[1]}-${dm[2]}-${dm[3]} ${dm[4]}` : "";
              return { r, t, btn, ts, len: t.length };
            })
            .filter((x) => x.t.includes(needle) && x.btn && x.len < 300)
            .sort((a, b) => b.ts.localeCompare(a.ts) || a.len - b.len);

        const exactMatches = parseRows(full);
        const matches = exactMatches.length ? exactMatches : parseRows(prefix);
        const top = matches[0];
        if (top) {
          top.btn.click();
          return { ok: true, matchedBy: exactMatches.length ? "fullTitle" : "prefix", savedAt: top.ts, rowText: top.t };
        }
        return { ok: false };
      },
      { full: fullTitle, prefix: titlePrefix }
    );
    if (!reopen.ok) throw new Error(`B 站草稿列表未找到含「${fullTitle}」的条目`);
    await page.waitForTimeout(3500);
    await muteAndPausePage(page);

    step = "verify";
    const verified = await page.evaluate(async () => {
      const url = location.href;
      const draftId = new URL(url).searchParams.get("draftId") || "";
      const title = document.querySelector('input.input-val[placeholder*="稿件标题"]')?.value || "";
      const cat = document.querySelector(".select-controller")?.innerText?.trim() || "";
      const tags = [...document.querySelectorAll(".label-item-v2-content")].map((el) => el.textContent?.trim());
      const decl = document.querySelector("input.bcc-select-input-inner")?.value || "";
      const selectedOpt = document.querySelector(".bcc-option.selected")?.innerText?.trim() || "";
      const authSelected = !!document.querySelector(
        ".auth-content .option-text-selected, .auth-content.option-text-selected"
      );
      const quill = document.querySelector("div.ql-editor")?.innerText?.trim() || "";
      const uploadComplete = (document.body?.innerText || "").includes("上传完成");
      const linkedActivities = [];
      for (const c of document.querySelectorAll(".label-item-v2-container")) {
        const cls = (c.className || "").toString();
        const tagText = c.querySelector(".label-item-v2-content")?.textContent?.trim() || "";
        const extraText = (c.innerText || "").replace(tagText, "").replace(/\s+/g, " ").trim();
        if (/activity|campaign/i.test(cls) || /活动/.test(extraText)) {
          linkedActivities.push(`标签活动:${tagText || extraText}`);
        }
      }
      const actHeading = [...document.querySelectorAll("div, span, p, label")].find(
        (el) =>
          el.children.length === 0 &&
          ["参与话题", "参与活动", "活动"].includes((el.innerText || el.textContent || "").trim()) &&
          el.getBoundingClientRect().height > 0
      );
      if (actHeading) {
        let row = actHeading.parentElement;
        for (let i = 0; i < 4 && row; i++) {
          const r = row.getBoundingClientRect();
          if (r.height >= 36 && r.height <= 260 && !(row.innerText || "").includes("创作声明")) break;
          row = row.parentElement;
        }
        if (row) {
          for (const el of row.querySelectorAll('[class*="active"], [class*="selected"], [class*="checked"]')) {
            const clsTokens = (el.className || "").toString().split(/\s+/);
            if (clsTokens.some((tok) => /inactive|unselected|unchecked/i.test(tok))) continue;
            const t = (el.innerText || "").replace(/\s+/g, " ").trim();
            const r = el.getBoundingClientRect();
            if (
              r.width > 0 &&
              r.height > 0 &&
              r.height < 64 &&
              t &&
              t.length <= 40 &&
              !["参与话题", "参与活动", "活动", "搜索更多话题", "不参与"].includes(t)
            ) {
              linkedActivities.push(t);
            }
          }
        }
      }
      let coverInfo = null;
      try {
        const cc = document.querySelector(".cover-content");
        const findCL = (v, d = 0) => (!v || d > 5 ? null : v.coverList || v.$props?.coverList || findCL(v.$parent, d + 1));
        const cl = findCL(cc?.__vue__);
        if (cl && cl[0]) {
          const probe = (src) =>
            new Promise((res) => {
              if (!src) return res(null);
              const im = new Image();
              im.onload = () =>
                res({
                  nw: im.naturalWidth,
                  nh: im.naturalHeight,
                  ratio: Number((im.naturalWidth / im.naturalHeight).toFixed(3)),
                  host: new URL(im.src).host,
                });
              im.onerror = () => res({ err: true });
              im.src = src.startsWith("//") ? "https:" + src : src;
            });
          const mainSrc = cl[0].main?.edited || cl[0].main?.origin;
          const extraSrc = cl[0].extra?.edited || cl[0].extra?.origin;
          coverInfo = {
            main_16x9: await probe(mainSrc),
            extra_4x3: await probe(extraSrc),
            mainSource: cl[0].main?.edited ? "edited" : cl[0].main?.origin ? "origin" : null,
            extraSource: cl[0].extra?.edited ? "edited" : cl[0].extra?.origin ? "origin" : null,
            differentUrls: !!mainSrc && !!extraSrc && mainSrc !== extraSrc,
          };
        }
      } catch (e) {
        coverInfo = { err: e.message };
      }
      return {
        url,
        draftId,
        uploadComplete,
        title,
        cat,
        tags,
        decl,
        selectedOpt,
        authSelected,
        quill,
        linkedActivities: [...new Set(linkedActivities)],
        coverInfo,
      };
    });

    const issues = [];
    const expectedOpt = job.aiGenerated ? "含AI生成内容" : "内容无需标注";
    if (!verified.uploadComplete) issues.push("未检测到「上传完成」信号");
    if (verified.title !== job.bilibili.title) issues.push(`标题不一致: "${verified.title}"`);
    if (verified.cat !== job.bilibili.category) issues.push(`分区不一致: 期望「${job.bilibili.category}」，实际「${verified.cat}」`);
    if (verified.selectedOpt && verified.selectedOpt !== expectedOpt) {
      issues.push(`创作声明不符: 期望「${expectedOpt}」，实际「${verified.selectedOpt}」`);
    }
    if (job.original && !verified.authSelected) issues.push("自制授权未勾选");
    if (!job.allowActivities && verified.linkedActivities?.length > 0) {
      issues.push(`存在未授权 B 站参与话题/活动: ${verified.linkedActivities.join("、")}`);
    }
    if (job.bilibili.cover4x3 && job.bilibili.cover16x9 && !verified.coverInfo?.differentUrls) {
      issues.push("首页 4:3 与空间 16:9 封面未呈现独立 URL（可能发生同步覆盖或未落盘）");
    }

    return {
      status: issues.length ? "needs_agent_fallback" : "ok",
      failedStep: issues.length ? "verify" : null,
      issues,
      reopen,
      verified,
    };
  } catch (err) {
    return makeFallback(step, err, await collectLightDiagnostics(page));
  }
}
