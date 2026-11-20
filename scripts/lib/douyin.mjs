import {
  bringToFront,
  collectLightDiagnostics,
  makeFallback,
  makeHandoff,
  muteAndPausePage,
} from "./utils.mjs";

export const DOUYIN_URL = "https://creator.douyin.com/creator-micro/content/upload";

/**
 * 阶段 1a：核验登录与「继续编辑」冲突防护，确认安全后注入视频。
 */
export async function douyinInspectAndInject(page, job) {
  await page.waitForSelector('input[type="file"]', { state: "attached", timeout: 15000 }).catch(() => {});
  const info = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const hasContinue = text.includes("继续编辑") || text.includes("未发布的视频");
    const idx = text.indexOf("未发布");
    const continueSnippet = hasContinue ? text.slice(Math.max(0, idx - 20), idx + 120) : "";
    const inputs = [...document.querySelectorAll('input[type="file"]')].map((el, i) => ({
      i,
      accept: el.accept || "",
    }));
    return { url: location.href, hasContinue, continueSnippet, inputs };
  });

  if (!info.url.includes("creator.douyin.com/creator-micro")) {
    return makeHandoff("login", "抖音创作者中心未登录或已跳转登录页，请先登录。", { info });
  }
  if (info.hasContinue && !job.douyin.allowContinueExisting) {
    return makeHandoff(
      "continue_edit_conflict",
      "抖音上传页存在上次未发布的视频「继续编辑」入口；为防覆盖其他作品，已暂停注入，请先辨认并确认。",
      { continueSnippet: info.continueSnippet }
    );
  }

  const vIdx = info.inputs.findIndex((x) => x.accept.includes("video") || x.accept.includes("mp4"));
  const sel = vIdx >= 0 ? `input[type="file"] >> nth=${vIdx}` : 'input[type="file"] >> nth=0';
  await page.setInputFiles(sel, [job.video.path]);
  return { status: "injected", hadContinue: info.hasContinue };
}

/**
 * 阶段 1b：填标题、选真实话题实体、设自主声明、传 3:4 + 4:3 双封面、点「暂存离开」。
 */
export async function douyinFillAndSave(page, job) {
  let step = "wait_editor";
  try {
    await bringToFront(page);
    await page.waitForSelector('input.semi-input[placeholder*="作品标题"]', { state: "visible", timeout: 25000 });
    await muteAndPausePage(page);

    // 1. 标题
    step = "title";
    await page.fill('input.semi-input[placeholder*="作品标题"]', job.douyin.title);
    await page.waitForTimeout(250);

    // 2. 简介清空并逐个选中真实话题实体
    step = "topics";
    await page.evaluate(() =>
      document.querySelector("div.zone-container.editor-kit-container")?.scrollIntoView({ block: "center" })
    );
    await page.waitForTimeout(250);
    await page.click("div.zone-container.editor-kit-container", { label: "focus Douyin desc" });
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);

    const topicLogs = [];
    for (const word of job.douyin.topics) {
      await page.click('text="#添加话题"', { label: `DY add topic ${word}` });
      await page.waitForTimeout(350);
      await page.keyboard.type(word, { delay: 55 });
      await page.waitForTimeout(950);

      const pick = await page.evaluate((w) => {
        const edRect = document.querySelector("div.zone-container.editor-kit-container")?.getBoundingClientRect();
        const cands = [];
        for (const el of document.querySelectorAll("div, li")) {
          const r = el.getBoundingClientRect();
          if (r.width < 100 || r.width > 550 || r.height < 22 || r.height > 75) continue;
          if (edRect && (r.top < edRect.top - 50 || r.top > edRect.bottom + 420)) continue;
          if (el.closest("div.zone-container.editor-kit-container")) continue;
          const txt = (el.innerText || "").trim();
          if (!txt || txt.length > 80) continue;
          const lines = txt.split("\n").map((s) => s.trim()).filter(Boolean);
          const firstLine = (lines[0] || "").replace(/^#/, "");
          if (!firstLine.toLowerCase().includes(w.toLowerCase())) continue;
          const meta = lines.slice(1).join(" ");
          const isActivity = /活动|任务|激励|有奖|挑战赛|征集/.test(meta);
          const hasPlayCount =
            txt.includes("播放") || txt.includes("万") || txt.includes("亿") || /\d+/.test(lines[1] || "");
          cands.push({
            firstLine,
            area: r.width * r.height,
            isActivity,
            hasPlayCount,
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
          });
        }
        cands.sort(
          (a, b) =>
            Number(a.isActivity) - Number(b.isActivity) ||
            Number(b.hasPlayCount) - Number(a.hasPlayCount) ||
            a.area - b.area
        );
        const nonActivity = cands.filter((c) => !c.isActivity);
        const pool = nonActivity.length ? nonActivity : cands;
        const chosen =
          pool.find((c) => c.firstLine.toLowerCase() === w.toLowerCase()) ||
          pool.find((c) => c.firstLine.toLowerCase().startsWith(w.toLowerCase())) ||
          pool[0];
        return chosen ? { found: true, ...chosen } : { found: false };
      }, word);

      if (pick.found) {
        await page.mouse.click(pick.x, pick.y, { label: `DY pick topic ${pick.firstLine}` });
        topicLogs.push({ word, chosen: pick.firstLine });
      } else {
        await page.keyboard.press("Enter");
        topicLogs.push({ word, chosen: "enter_fallback" });
      }
      await page.waitForTimeout(450);
    }

    // 3. 自主声明（内容由AI生成 vs 无需添加自主声明）
    step = "self_declaration";
    const targetDecl = job.aiGenerated ? "内容由AI生成" : "无需添加自主声明";
    await page.evaluate(() => document.querySelector(".selectBox-buZRzi")?.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(250);
    const declBefore = await page.evaluate(() => document.querySelector(".selectBox-buZRzi")?.innerText?.trim() || "");
    if (!declBefore.includes(targetDecl)) {
      await page.click(".selectBox-buZRzi", { label: "open DY self declaration" });
      await page.waitForTimeout(600);
      const optRect = await page.evaluate((target) => {
        const pops = [
          ...document.querySelectorAll('.semi-modal, .semi-popover, .semi-select-option-list, [role="dialog"], [role="listbox"]'),
        ].filter((e) => e.getBoundingClientRect().height > 30);
        const cands = [];
        for (const p of pops) {
          for (const el of p.querySelectorAll("div, li, span, label")) {
            const t = (el.innerText || "").trim();
            const r = el.getBoundingClientRect();
            if (t === target && r.height >= 16 && r.height <= 65 && el.children.length <= 2) {
              cands.push({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), area: r.width * r.height });
            }
          }
        }
        cands.sort((a, b) => a.area - b.area);
        return cands[0] || null;
      }, targetDecl);
      if (!optRect) throw new Error(`未在抖音自主声明弹窗中找到「${targetDecl}」`);
      await page.mouse.click(optRect.x, optRect.y, { label: `select DY ${targetDecl}` });
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('.semi-modal button, [role="dialog"] button')].find(
          (b) => (b.innerText || "").trim() === "确定" && b.getBoundingClientRect().height > 0
        );
        if (btn) btn.click();
      });
      await page.waitForTimeout(450);
    }

    // 4. 双封面（3:4 竖封 + 4:3 横封；自动适配竖屏联合双 Tab 弹窗与横屏独立单槽弹窗）
    step = "covers";
    const coverLog = {};
    if (job.douyin.cover3x4 || job.douyin.cover4x3) {
      const clickModalDone = async (tag) => {
        const doneRect = await page.evaluate(() => {
          const btns = [...document.querySelectorAll("button, div")].filter((el) => (el.textContent || "").trim() === "完成");
          for (const b of btns) {
            const r = b.getBoundingClientRect();
            if (r.width > 40 && r.height > 20 && r.y > 400) {
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
          }
          return null;
        });
        if (!doneRect) throw new Error(`未找到抖音${tag}封面弹窗底部「完成」按钮`);
        await page.mouse.click(doneRect.x, doneRect.y, { label: `confirm DY ${tag} cover` });
        await page.waitForTimeout(3000);
      };

      const uploadInOpenModal = async (tabName, filePath, tag) => {
        if (!filePath) return "not_provided";
        const tabRect = await page.evaluate((name) => {
          const el = [...document.querySelectorAll("div, span, button")].find(
            (n) => n.children.length === 0 && (n.textContent || "").trim() === name && n.getBoundingClientRect().width > 0
          );
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }, tabName);
        if (tabRect) {
          await page.mouse.click(tabRect.x, tabRect.y, { label: `DY switch ${tabName}` });
          await page.waitForTimeout(1000);
        }
        // 处理「使用此素材作为封面？」->「直接编辑」
        const directRect = await page.evaluate(() => {
          const el = [...document.querySelectorAll("button, div, span")].find(
            (n) => (n.textContent || "").trim() === "直接编辑" && n.getBoundingClientRect().width > 0
          );
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        });
        if (directRect) {
          await page.mouse.click(directRect.x, directRect.y, { label: `DY direct edit ${tag}` });
          await page.waitForTimeout(1000);
        }
        const upRect = await page.evaluate(() => {
          const tips = document.querySelector(".upload-tips-KomyJM");
          if (tips && tips.getBoundingClientRect().width > 20) {
            const r = tips.getBoundingClientRect();
            return { kind: "tips", x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
          const el = [...document.querySelectorAll("*")].find(
            (n) => n.children.length === 0 && (n.textContent || "").trim() === "上传封面" && n.getBoundingClientRect().width > 0
          );
          if (el) {
            const r = (el.parentElement || el).getBoundingClientRect();
            return { kind: "btn", x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
          const drop = [...document.querySelectorAll("*")].find(
            (n) => (n.textContent || "").trim() === "点击上传文件或拖拽文件到这里" && n.getBoundingClientRect().width > 0
          );
          if (drop) {
            const r = drop.getBoundingClientRect();
            return { kind: "drop", x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
          return null;
        });
        if (!upRect) throw new Error(`抖音 ${tabName} 未找到上传封面按钮`);

        let chooser = null;
        const cp = page.waitForFileChooser({ timeout: 2500 }).then((c) => (chooser = c)).catch(() => {});
        await page.mouse.click(upRect.x, upRect.y, { label: `DY click upload ${tag}` });
        await cp;
        if (chooser) {
          await chooser.setFiles(filePath);
          await page.waitForTimeout(2400);
          return "direct:" + upRect.kind;
        }
        await page.waitForTimeout(800);
        const dragRect = await page.evaluate(() => {
          const el = [...document.querySelectorAll("*")].find(
            (n) => (n.textContent || "").trim() === "点击上传文件或拖拽文件到这里" && n.getBoundingClientRect().width > 0
          );
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        });
        if (!dragRect) throw new Error(`抖音 ${tabName} 点击后未出现拖拽上传区`);
        const c2p = page.waitForFileChooser({ timeout: 8000 });
        await page.mouse.click(dragRect.x, dragRect.y, { label: `DY dropzone ${tag}` });
        const c2 = await c2p;
        await c2.setFiles(filePath);
        await page.waitForTimeout(2400);
        return "dropzone";
      };

      const openCoverSlotCard = async (keyword) => {
        const rect = await page.evaluate((kw) => {
          const cards = [...document.querySelectorAll(".coverControl-CjlzqC")];
          const target =
            cards.find((c) => (c.innerText || "").includes(kw)) ||
            document.querySelector(".cover-Jg3T4p");
          if (!target) return null;
          target.scrollIntoView({ block: "center" });
          const r = target.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }, keyword);
        if (!rect) throw new Error(`未找到抖音「${keyword}」封面入口卡片`);
        await page.waitForTimeout(350);
        await page.mouse.click(rect.x, rect.y, { label: `open DY ${keyword} editor` });
        await page.waitForTimeout(1800);
      };

      // 先从第一张卡（横屏时优先横封面、竖屏时优先竖封面）进入，检测是否为联合双 Tab 弹窗
      const firstKw = job.video.orientation === "landscape" ? "横封面" : "竖封面";
      await openCoverSlotCard(firstKw);
      const hasBothTabs = await page.evaluate(() => {
        const texts = [...document.querySelectorAll("div, span, button")]
          .filter((n) => n.children.length === 0 && n.getBoundingClientRect().width > 0)
          .map((n) => (n.textContent || "").trim());
        return texts.includes("设置竖封面") && texts.includes("设置横封面");
      });
      coverLog.modalMode = hasBothTabs ? "dual_tab" : "independent_slots";

      if (hasBothTabs) {
        coverLog.v3x4 = await uploadInOpenModal("设置竖封面", job.douyin.cover3x4, "3:4");
        coverLog.h4x3 = await uploadInOpenModal("设置横封面", job.douyin.cover4x3, "4:3");
        await clickModalDone("dual");
      } else {
        // 横屏独立单槽弹窗：先传已打开的槽位并完成，再独立打开另一槽位传图
        if (firstKw === "横封面") {
          if (job.douyin.cover4x3) {
            coverLog.h4x3 = await uploadInOpenModal("设置横封面", job.douyin.cover4x3, "4:3");
            await clickModalDone("4:3");
          } else {
            await page.keyboard.press("Escape").catch(() => {});
            await page.waitForTimeout(600);
          }
          if (job.douyin.cover3x4) {
            await openCoverSlotCard("竖封面");
            coverLog.v3x4 = await uploadInOpenModal("设置竖封面", job.douyin.cover3x4, "3:4");
            await clickModalDone("3:4");
          }
        } else {
          if (job.douyin.cover3x4) {
            coverLog.v3x4 = await uploadInOpenModal("设置竖封面", job.douyin.cover3x4, "3:4");
            await clickModalDone("3:4");
          } else {
            await page.keyboard.press("Escape").catch(() => {});
            await page.waitForTimeout(600);
          }
          if (job.douyin.cover4x3) {
            await openCoverSlotCard("横封面");
            coverLog.h4x3 = await uploadInOpenModal("设置横封面", job.douyin.cover4x3, "4:3");
            await clickModalDone("4:3");
          }
        }
      }
      coverLog.done = true;
    }

    // 5. 等待视频上传结束并点「暂存离开」
    step = "save_draft";
    await page
      .waitForFunction(
        () => {
          const t = document.body?.innerText || "";
          return !t.includes("上传中") && !t.includes("正在上传");
        },
        undefined,
        { timeout: 25000 }
      )
      .catch(() => {});

    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => (b.innerText || "").trim() === "暂存离开" && b.getBoundingClientRect().height > 0
      );
      btn?.scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(300);
    await page.click('button:has-text("暂存离开")', { label: "save DY draft" });
    await page.waitForTimeout(3500);

    const afterSave = await page.evaluate(() => ({
      url: location.href,
      hasContinue: (document.body?.innerText || "").includes("继续编辑"),
    }));
    if (!afterSave.hasContinue) {
      return makeFallback("save_draft", "抖音点击暂存离开后未检测到「继续编辑」入口", await collectLightDiagnostics(page), {
        topicLogs,
        coverLog,
        afterSave,
      });
    }

    return { status: "ok", topicLogs, coverLog, afterSave };
  } catch (err) {
    return makeFallback(step, err, await collectLightDiagnostics(page));
  }
}

/**
 * 阶段 2：从上传页点「继续编辑」复开同一稿，核对字段、话题实体、声明与双封面。
 */
export async function douyinReopenAndVerify(page, job) {
  let step = "reopen";
  try {
    await bringToFront(page);
    const hasContinue = await page.evaluate(() => (document.body?.innerText || "").includes("继续编辑"));
    if (!hasContinue && !(await page.url()).includes("enter_from=draft")) {
      await page.goto(DOUYIN_URL, { timeout: 20000 });
      await page.waitForTimeout(2500);
    }
    if ((await page.evaluate(() => (document.body?.innerText || "").includes("继续编辑")))) {
      await page.click('text="继续编辑"', { label: "reopen DY draft" });
      await page.waitForTimeout(3500);
    }
    await muteAndPausePage(page);

    step = "verify";
    const verified = await page.evaluate(() => {
      const title = document.querySelector('input.semi-input[placeholder*="作品标题"]')?.value || "";
      const ed = document.querySelector("div.zone-container.editor-kit-container");
      const mentions = [...(ed?.querySelectorAll("[data-mention]") || [])].map((e) => e.textContent?.trim());
      const decl = document.querySelector(".selectBox-buZRzi")?.innerText?.trim() || "";
      const covers = [...document.querySelectorAll(".coverControl-CjlzqC")].map((c) => ({
        slot: (c.innerText || "").replace(/\s+/g, " ").slice(0, 20),
        imgs: [...c.querySelectorAll("img")].map((img) => ({
          nw: img.naturalWidth,
          nh: img.naturalHeight,
          ratio: img.naturalHeight ? Number((img.naturalWidth / img.naturalHeight).toFixed(3)) : 0,
          host: (() => {
            try {
              return new URL(img.currentSrc || img.src).host;
            } catch {
              return "";
            }
          })(),
        })),
      }));
      const vids = [...document.querySelectorAll("video")].map((v) => ({
        rs: v.readyState,
        dur: Number(v.duration?.toFixed?.(2)),
        vw: v.videoWidth,
        vh: v.videoHeight,
      }));
      const txt = (document.body?.innerText || "").replace(/\s+/g, " ");
      const linkedActivities = [];
      for (const labelEl of document.querySelectorAll("div, span, label, p")) {
        if (labelEl.children.length > 0) continue;
        const lt = (labelEl.innerText || labelEl.textContent || "").trim();
        if (!["添加活动", "参与活动", "关联活动", "活动", "任务"].includes(lt)) continue;
        const lr = labelEl.getBoundingClientRect();
        if (lr.height <= 0 || lr.height > 45) continue;
        let row = labelEl.parentElement;
        for (let i = 0; i < 4 && row; i++) {
          const rr = row.getBoundingClientRect();
          if (rr.width > 200 && rr.height >= 28 && rr.height <= 180) break;
          row = row.parentElement;
        }
        if (!row) continue;
        const rowTxt = (row.innerText || "").replace(/\s+/g, " ").trim();
        if (/取消关联|取消参与|删除活动|已参与/.test(rowTxt)) {
          linkedActivities.push(rowTxt.slice(0, 60));
        }
      }
      return {
        url: location.href,
        title,
        count: txt.match(/\d+\/30/)?.[0] || "",
        mentions,
        decl,
        missingCoverWarn: txt.includes("横/竖双封面缺失"),
        linkedActivities: [...new Set(linkedActivities)],
        covers,
        vids,
      };
    });

    const issues = [];
    const expectedDecl = job.aiGenerated ? "内容由AI生成" : "无需添加自主声明";
    if (verified.title !== job.douyin.title) issues.push(`标题不一致（可能复开了别的稿）: "${verified.title}"`);
    if (verified.mentions.length < job.douyin.topics.length) {
      issues.push(`话题实体数量不足: ${verified.mentions.length}/${job.douyin.topics.length}`);
    }
    if (!verified.decl.includes(expectedDecl)) issues.push(`自主声明不符: 期望「${expectedDecl}」，实际「${verified.decl}」`);
    if (!job.allowActivities && verified.linkedActivities?.length > 0) {
      issues.push(`存在未授权关联活动/任务: ${verified.linkedActivities.join("、")}`);
    }
    if (job.douyin.cover3x4 && job.douyin.cover4x3 && verified.missingCoverWarn) {
      issues.push("页面仍显示「横/竖双封面缺失」");
    }
    if (job.douyin.cover4x3) {
      const hSlot = verified.covers.find((c) => c.slot.includes("横封面"));
      const hRatio = hSlot?.imgs?.[0]?.ratio || 0;
      if (hSlot && hRatio < 1.15) {
        issues.push(`抖音横封面比例异常 (ratio=${hRatio})，疑似未落入 4:3 横图`);
      }
    }
    if (job.douyin.cover3x4) {
      const vSlot = verified.covers.find((c) => c.slot.includes("竖封面"));
      const vRatio = vSlot?.imgs?.[0]?.ratio || 0;
      if (vSlot && (vRatio <= 0 || vRatio > 0.9)) {
        issues.push(`抖音竖封面比例异常 (ratio=${vRatio})，疑似被横封面覆盖`);
      }
    }

    return {
      status: issues.length ? "needs_agent_fallback" : "ok",
      failedStep: issues.length ? "verify" : null,
      issues,
      verified,
    };
  } catch (err) {
    return makeFallback(step, err, await collectLightDiagnostics(page));
  }
}
