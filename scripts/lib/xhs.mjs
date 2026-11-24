import {
  bringToFront,
  collectLightDiagnostics,
  makeFallback,
  makeHandoff,
  muteAndPausePage,
} from "./utils.mjs";

export const XHS_URL = "https://creator.xiaohongshu.com/publish/publish";

/**
 * 只读扫描小红书「关联活动」区块内处于已关联状态（出现「取消关联」按钮）的活动卡片。
 * 严格限定在「关联活动」区域内，绝不误碰「商业组件」或其他开关。
 */
async function inspectXhsLinkedActivities(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const heading = [...document.querySelectorAll("div, span, p, h2, h3, h4, label")].find(
      (el) => el.children.length === 0 && (el.innerText || el.textContent || "").trim() === "关联活动" && isVisible(el)
    );
    let scope = null;
    if (heading) {
      let cur = heading.parentElement;
      for (let i = 0; i < 6 && cur; i++) {
        const r = cur.getBoundingClientRect();
        const txt = cur.innerText || "";
        if (r.height >= 60 && r.height <= 560 && !txt.includes("商业组件") && !txt.includes("定时发布")) {
          scope = cur;
        }
        cur = cur.parentElement;
      }
    }
    const headingRect = heading?.getBoundingClientRect() || null;
    const root = scope || document;
    const rawBtns = [...root.querySelectorAll("button, a, span, div")].filter((el) => {
      if (el.children.length > 1) return false;
      const t = (el.innerText || el.textContent || "").trim();
      if (t !== "取消关联") return false;
      const r = el.getBoundingClientRect();
      if (r.width < 12 || r.height < 8 || r.height > 64) return false;
      if (!scope) {
        const cardText = (el.parentElement?.parentElement?.innerText || el.parentElement?.innerText || "").trim();
        const nearHeading = headingRect && r.top >= headingRect.top - 20 && r.top <= headingRect.bottom + 380;
        const hasDateRange = /\d{2}-\d{2}\s*至\s*\d{2}-\d{2}/.test(cardText);
        if (!nearHeading && !hasDateRange) return false;
      }
      return true;
    });

    const dedup = [];
    for (const el of rawBtns) {
      if (rawBtns.some((other) => other !== el && el.contains(other))) continue;
      let card = el.parentElement;
      for (let i = 0; i < 4 && card; i++) {
        const cr = card.getBoundingClientRect();
        if (cr.width > 120 && cr.height >= 40 && cr.height <= 160) break;
        card = card.parentElement;
      }
      const cardLines = (card?.innerText || "")
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s && s !== "取消关联");
      dedup.push({ name: cardLines[0] || "未命名活动" });
    }
    return dedup;
  });
}

/**
 * 解除小红书因添加话题被平台自动勾上的「关联活动」（逐个滚动并点击「取消关联」）。
 * 绝不点击「关联」按钮。
 */
async function unlinkXhsActivities(page) {
  const unlinked = [];
  for (let guard = 0; guard < 5; guard++) {
    const scrolled = await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const heading = [...document.querySelectorAll("div, span, p, h2, h3, h4, label")].find(
        (el) => el.children.length === 0 && (el.innerText || el.textContent || "").trim() === "关联活动" && isVisible(el)
      );
      let scope = null;
      if (heading) {
        let cur = heading.parentElement;
        for (let i = 0; i < 6 && cur; i++) {
          const r = cur.getBoundingClientRect();
          const txt = cur.innerText || "";
          if (r.height >= 60 && r.height <= 560 && !txt.includes("商业组件") && !txt.includes("定时发布")) {
            scope = cur;
          }
          cur = cur.parentElement;
        }
      }
      const headingRect = heading?.getBoundingClientRect() || null;
      const root = scope || document;
      const rawBtns = [...root.querySelectorAll("button, a, span, div")].filter((el) => {
        if (el.children.length > 1) return false;
        const t = (el.innerText || el.textContent || "").trim();
        if (t !== "取消关联") return false;
        const r = el.getBoundingClientRect();
        if (r.width < 12 || r.height < 8 || r.height > 64) return false;
        if (!scope) {
          const cardText = (el.parentElement?.parentElement?.innerText || el.parentElement?.innerText || "").trim();
          const nearHeading = headingRect && r.top >= headingRect.top - 20 && r.top <= headingRect.bottom + 380;
          const hasDateRange = /\d{2}-\d{2}\s*至\s*\d{2}-\d{2}/.test(cardText);
          if (!nearHeading && !hasDateRange) return false;
        }
        return true;
      });
      const leaf = rawBtns.find((el) => !rawBtns.some((other) => other !== el && el.contains(other)));
      if (!leaf) return false;
      leaf.scrollIntoView({ block: "center", behavior: "instant" });
      return true;
    });
    if (!scrolled) break;
    await page.waitForTimeout(250);
    const target = await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const heading = [...document.querySelectorAll("div, span, p, h2, h3, h4, label")].find(
        (el) => el.children.length === 0 && (el.innerText || el.textContent || "").trim() === "关联活动" && isVisible(el)
      );
      let scope = null;
      if (heading) {
        let cur = heading.parentElement;
        for (let i = 0; i < 6 && cur; i++) {
          const r = cur.getBoundingClientRect();
          const txt = cur.innerText || "";
          if (r.height >= 60 && r.height <= 560 && !txt.includes("商业组件") && !txt.includes("定时发布")) {
            scope = cur;
          }
          cur = cur.parentElement;
        }
      }
      const headingRect = heading?.getBoundingClientRect() || null;
      const root = scope || document;
      const rawBtns = [...root.querySelectorAll("button, a, span, div")].filter((el) => {
        if (el.children.length > 1) return false;
        const t = (el.innerText || el.textContent || "").trim();
        if (t !== "取消关联") return false;
        const r = el.getBoundingClientRect();
        if (r.width < 12 || r.height < 8 || r.height > 64) return false;
        if (!scope) {
          const cardText = (el.parentElement?.parentElement?.innerText || el.parentElement?.innerText || "").trim();
          const nearHeading = headingRect && r.top >= headingRect.top - 20 && r.top <= headingRect.bottom + 380;
          const hasDateRange = /\d{2}-\d{2}\s*至\s*\d{2}-\d{2}/.test(cardText);
          if (!nearHeading && !hasDateRange) return false;
        }
        return true;
      });
      const leaf = rawBtns.find((el) => !rawBtns.some((other) => other !== el && el.contains(other)));
      if (!leaf) return null;
      const r = leaf.getBoundingClientRect();
      let card = leaf.parentElement;
      for (let i = 0; i < 4 && card; i++) {
        const cr = card.getBoundingClientRect();
        if (cr.width > 120 && cr.height >= 40 && cr.height <= 160) break;
        card = card.parentElement;
      }
      const cardLines = (card?.innerText || "")
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s && s !== "取消关联");
      return {
        name: cardLines[0] || "未命名活动",
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
      };
    });
    if (!target) break;
    await page.mouse.click(target.x, target.y, { label: `unlink XHS auto activity ${target.name}` });
    unlinked.push(target.name);
    await page.waitForTimeout(550);
  }
  return unlinked;
}

/**
 * 阶段 1a：检查登录态、记录原有草稿数，并注入成片。
 */
export async function xhsInspectAndInject(page, job) {
  await page.waitForSelector("input.upload-input", { state: "attached", timeout: 15000 }).catch(() => {});
  const info = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const user =
      document.querySelector(".account-name, .user-name, .name-box, .header-user-name")?.textContent?.trim() || "";
    const draftHint = text.match(/草稿箱[^\n]{0,12}/)?.[0] || "";
    const draftCount = Number(draftHint.match(/\((\d+)\)/)?.[1] ?? -1);
    const hasUploadInput = !!document.querySelector("input.upload-input");
    return { url: location.href, user, draftHint, draftCount, hasUploadInput };
  });

  if (!info.url.includes("creator.xiaohongshu.com/publish") || !info.hasUploadInput) {
    return makeHandoff("login", "小红书未登录或未停留在发布页，请先登录或接管。", { info });
  }
  if (info.draftCount >= 100) {
    return makeHandoff("draft_quota", "小红书本地草稿箱已达 100 条容量上限，请先由作者决定清理哪些旧稿。", { info });
  }

  const uploadPath = job.xhs.videoPath || job.video.path;
  await page.setInputFiles("input.upload-input", [uploadPath]);
  return { status: "injected", user: info.user, draftHintBefore: info.draftHint, videoPath: uploadPath };
}

/**
 * 阶段 1b：填标题、选真实话题实体、设原创与内容类型声明、传匹配方向封面、点「暂存离开」。
 */
export async function xhsFillAndSave(page, job) {
  let step = "wait_editor";
  try {
    await bringToFront(page);
    await page.waitForSelector('input.d-text[placeholder*="填写标题"]', { state: "visible", timeout: 25000 });
    await muteAndPausePage(page);

    // 1. 标题
    step = "title";
    await page.fill('input.d-text[placeholder*="填写标题"]', job.xhs.title);
    await page.waitForTimeout(250);

    // 2. 正文聚焦（避开底部悬浮 <xhs-publish-btn>）+ 逐个选真实话题实体
    step = "topics";
    const edTop = await page.evaluate(() => {
      const ed = document.querySelector("div.tiptap.ProseMirror");
      if (!ed) return null;
      ed.scrollIntoView({ block: "center" });
      ed.focus();
      const r = ed.getBoundingClientRect();
      return { x: Math.round(r.left + 40), y: Math.round(r.top + 20) };
    });
    if (!edTop) throw new Error("未找到正文编辑器 div.tiptap.ProseMirror");
    await page.waitForTimeout(200);
    await page.mouse.click(edTop.x, edTop.y, { label: "focus XHS body top" });
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);

    if (job.xhs.description) {
      await page.keyboard.insertText(job.xhs.description);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(250);
    }

    const topicLogs = [];
    for (const word of job.xhs.topics) {
      await page.evaluate(() => {
        const ed = document.querySelector("div.tiptap.ProseMirror");
        if (!ed) return;
        ed.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(ed);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        document.querySelector("button.contentBtn.topic-btn")?.click();
      });
      await page.waitForTimeout(280);
      await page.keyboard.type(word, { delay: 45 });

      await page
        .waitForFunction(
          (w) => {
            const items = [...document.querySelectorAll(".tippy-box .item")];
            return items.some((el) => (el.innerText || "").toLowerCase().includes(w.toLowerCase()));
          },
          word,
          { timeout: 6000 }
        )
        .catch(() => {});
      await page.waitForTimeout(400);

      const pick = await page.evaluate((w) => {
        const items = [...document.querySelectorAll(".tippy-box .item")].filter(
          (el) => el.getBoundingClientRect().height > 10
        );
        const parsed = items
          .map((el) => {
            const lines = (el.innerText || "")
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            const name = (lines[0] || "").replace(/^#/, "");
            const meta = lines.slice(1).join(" ");
            const isActivity = /活动|参与|有奖|打卡|征集/.test(meta);
            return { el, name, isActivity };
          })
          .filter((x) => x.name);
        const nonActivity = parsed.filter((x) => !x.isActivity);
        const pool = nonActivity.length ? nonActivity : parsed;
        const chosen =
          pool.find((x) => x.name.toLowerCase() === w.toLowerCase()) ||
          pool.find((x) => x.name.toLowerCase().startsWith(w.toLowerCase())) ||
          pool.find((x) => x.name.toLowerCase().includes(w.toLowerCase()));
        if (chosen) chosen.el.click();
        return { word: w, chosen: chosen?.name || null, skippedActivity: nonActivity.length < parsed.length };
      }, word);
      topicLogs.push(pick);
      await page.waitForTimeout(350);
    }

    // 3. 原创声明（只操作 .original-wrapper .d-switch，绝不误碰定时发布）
    step = "original_declaration";
    const origChecked = await page.evaluate(
      () => !!document.querySelector('.original-wrapper input[type="checkbox"]')?.checked
    );
    if (job.original && !origChecked) {
      await page.evaluate(() =>
        document.querySelector(".original-wrapper .d-switch")?.scrollIntoView({ block: "center" })
      );
      await page.waitForTimeout(200);
      await page.click(".original-wrapper .d-switch", { label: "enable XHS original" });
      await page.waitForTimeout(600);
      const hasModal = await page.evaluate(() => !!document.querySelector(".originalContainer"));
      if (hasModal) {
        await page.click(".originalContainer .d-checkbox-simulator", { label: "agree XHS original" });
        await page.waitForTimeout(250);
        await page.evaluate(() => {
          const btn = [...document.querySelectorAll(".originalContainer button, button")].find(
            (b) => (b.innerText || "").trim() === "声明原创" && b.getBoundingClientRect().height > 0
          );
          if (btn) btn.click();
        });
        await page.waitForTimeout(500);
      }
    }

    // 4. 内容类型声明（含 AI 生成内容选「笔记含AI合成内容」；否则留空不选）
    step = "ai_declaration";
    if (job.aiGenerated) {
      await page.evaluate(() => {
        const el = [...document.querySelectorAll(".d-select")].find((n) =>
          (n.innerText || "").includes("内容类型声明")
        );
        el?.scrollIntoView({ block: "center" });
      });
      await page.waitForTimeout(250);
      await page.click('text="添加内容类型声明"', { label: "open XHS content type declaration" }).catch(async () => {
        await page.evaluate(() => {
          const el = [...document.querySelectorAll(".d-select")].find((n) =>
            (n.innerText || "").includes("内容类型声明")
          );
          el?.click();
        });
      });
      await page.waitForTimeout(600);
      const aiPicked = await page.evaluate(() => {
        const opt = [...document.querySelectorAll("div, li, span")].find(
          (el) =>
            (el.innerText || "").trim() === "笔记含AI合成内容" &&
            el.getBoundingClientRect().height > 10 &&
            el.getBoundingClientRect().height < 70
        );
        if (opt) {
          opt.click();
          return true;
        }
        return false;
      });
      if (!aiPicked) throw new Error("未在小红书内容类型声明下拉中找到「笔记含AI合成内容」");
      await page.waitForTimeout(450);
    }

    // 4.5 可选地点（仅当作者显式确认并传入 job.xhs.location 时填写，绝不写死默认值）
    step = "location";
    let locationLog = { skipped: true, target: "", selected: "" };
    if (job.xhs.location && job.xhs.location !== "不显示位置") {
      const targetLoc = job.xhs.location;
      const queryLoc = job.xhs.locationQuery || targetLoc;
      await page.evaluate(() => {
        const el = [...document.querySelectorAll("div, span, input")].find(
          (n) => (n.innerText || n.placeholder || "").trim() === "添加地点" && n.getBoundingClientRect().height > 8
        );
        el?.scrollIntoView({ block: "center", behavior: "instant" });
      });
      await page.waitForTimeout(300);
      await page.click('text="添加地点"', { label: "focus XHS location picker", timeout: 6000 });
      await page.waitForTimeout(550);
      await page.keyboard.type(queryLoc, { delay: 65 });
      await page.waitForTimeout(1800);

      const picked = await page.evaluate((target) => {
        const isSubPoi = (t) => /(停车场|接送点|招商办公室|便利店|银泰百货|[A-Z]栋|\(.*(?:店|门|出口)\)|（.*(?:店|门|出口)）)/.test(t);
        const chars = [...target.replace(/\s+/g, "")];
        const isSubseq = (hay) => {
          let i = 0;
          for (const ch of hay) if (i < chars.length && ch === chars[i]) i++;
          return i === chars.length;
        };
        const els = [...document.querySelectorAll('.d-popover li, .d-dropdown li, [class*="poi"], [class*="location"] [class*="item"], [role="option"], .d-select-dropdown div, div')]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            const t = (el.innerText || "").trim();
            if (r.width < 80 || r.height < 18 || r.height > 95) return false;
            if (!t || t.length > 80 || t.includes("\n")) return false;
            if (/^(添加地点|标记地点或标记朋友)$/.test(t)) return false;
            return t.includes(target) || isSubseq(t);
          });
        const leaf = els.filter((el) => !els.some((o) => o !== el && el.contains(o)));
        const scored = leaf.map((el) => {
          const name = (el.innerText || "").trim();
          const r = el.getBoundingClientRect();
          let score = 0;
          if (name === target) score += 100;
          else if (name.startsWith(target)) score += 60;
          else if (isSubseq(name)) score += 45;
          if (!isSubPoi(name)) score += 30;
          score -= Math.min(20, Math.abs(name.length - target.length));
          return { name, score, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        });
        scored.sort((a, b) => b.score - a.score);
        return { best: scored[0] || null, candidates: scored.slice(0, 6).map((s) => s.name) };
      }, targetLoc);

      if (!picked.best) {
        throw new Error(`小红书地点搜索「${queryLoc}」未找到匹配「${targetLoc}」的 POI 候选`);
      }
      await page.mouse.click(picked.best.x, picked.best.y, { label: "select XHS location POI" });
      await page.waitForTimeout(800);
      locationLog = { skipped: false, target: targetLoc, query: queryLoc, selected: picked.best.name, candidates: picked.candidates };
    }

    // 5. 封面（竖屏默认 3:4；横屏 4:3 上传后必须切到左侧「裁剪 -> 4:3」）
    step = "cover";
    let coverResult = "skipped_no_cover_provided";
    if (job.xhs.coverPath) {
      await page.waitForSelector(".default--ai-cover-layout", { state: "visible", timeout: 20000 });
      await page.evaluate(() =>
        document.querySelector(".default--ai-cover-layout")?.scrollIntoView({ block: "center" })
      );
      await page.waitForTimeout(250);
      await page.hover(".default--ai-cover-layout", { label: "hover XHS cover" });
      await page.waitForTimeout(450);
      const hasEntry = await page.evaluate(() => !!document.querySelector(".cover-edit-entry"));
      if (hasEntry) {
        await page.click(".cover-edit-entry", { label: "open XHS cover editor" });
      } else {
        await page.click(".default--ai-cover-layout", { label: "open XHS cover editor" });
      }
      await page.waitForTimeout(1200);

      // 若新版封面编辑器提示视频加载问题，自动点「回退到旧版」
      const fellBack = await page.evaluate(() => {
        const fb = [...document.querySelectorAll("a, button, span, div")].find(
          (el) => (el.innerText || "").trim().includes("回退到旧版") && el.getBoundingClientRect().height > 0
        );
        if (fb) {
          fb.click();
          return true;
        }
        return false;
      });
      if (fellBack) await page.waitForTimeout(900);

      const imgSel = await page.evaluate(() => {
        const inp =
          document.querySelector('input[aria-label="上传封面图片"]') ||
          document.querySelector('input[type="file"][accept*="image"]');
        if (!inp) return null;
        return inp.getAttribute("aria-label")
          ? `input[aria-label="${inp.getAttribute("aria-label")}"]`
          : 'input[type="file"][accept*="image"]';
      });
      if (!imgSel) throw new Error("未在小红书封面弹窗中找到图片上传 input");

      await page.setInputFiles(imgSel, [job.xhs.coverPath]);
      await page.waitForTimeout(2200);

      // 横屏 4:3 时必须切到裁剪 -> 4:3（弹窗默认 3:4）
      if (job.xhs.coverRatio === "4x3") {
        const cropClicked = await page.evaluate(() => {
          const modal = document.querySelector(".main-cover-editor-modal, .d-modal");
          if (!modal) return "no_modal";
          const cropTab = [...modal.querySelectorAll("div, span, button")].find(
            (el) => (el.innerText || "").trim() === "裁剪" && el.getBoundingClientRect().height > 0
          );
          if (cropTab) cropTab.click();
          return cropTab ? "clicked_crop" : "no_crop_tab";
        });
        await page.waitForTimeout(500);
        const ratio43Clicked = await page.evaluate(() => {
          const modal = document.querySelector(".main-cover-editor-modal, .d-modal");
          if (!modal) return false;
          const r43 = [...modal.querySelectorAll("div, span, button")].find(
            (el) => (el.innerText || "").trim() === "4:3" && el.getBoundingClientRect().height > 0
          );
          if (r43) {
            r43.click();
            return true;
          }
          return false;
        });
        await page.waitForTimeout(500);
        if (!ratio43Clicked) {
          throw new Error(`小红书横屏 4:3 封面未能切换到 4:3 裁剪框（cropTab=${cropClicked}）`);
        }
      }

      const confirmed = await page.evaluate(() => {
        const modal = document.querySelector(".main-cover-editor-modal, .d-modal");
        if (!modal) return null;
        const btns = [...modal.querySelectorAll('button, [role="button"]')].filter(
          (b) => b.getBoundingClientRect().height > 0
        );
        const ok =
          btns.find((b) => (b.innerText || "").trim() === "确定") ||
          btns.find((b) => (b.innerText || "").trim() === "完成");
        if (ok) {
          ok.click();
          return ok.innerText.trim();
        }
        return null;
      });
      if (!confirmed) throw new Error("未找到小红书封面弹窗内的「完成/确定」按钮");
      await page.waitForTimeout(2200);
      coverResult = `uploaded_${job.xhs.coverRatio}_confirmed_${confirmed}`;
    }

    // 5.5 解除平台因话题联动自动勾选的「关联活动」（全平台红线：除非显式 allowActivities）
    step = "unlink_activities";
    let unlinkedActivities = [];
    if (!job.allowActivities) {
      await page.waitForTimeout(300);
      unlinkedActivities = await unlinkXhsActivities(page);
    }

    // 6. 等待视频上传结束并点「暂存离开」
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

    try {
      await page.click('text="暂存离开"', { label: "save XHS draft", timeout: 5000 });
    } catch {
      const snap = await page.snapshot({ scope: "full_page" });
      const m = snap.match(/\[ref=(\d+)[^\]]*\]\n\s+text "暂存离开"/);
      if (!m) throw new Error("未找到小红书「暂存离开」按钮");
      await page.click(`@${m[1]}`, { label: "save XHS draft by ref" });
    }
    await page.waitForTimeout(3000);

    const afterSave = await page.evaluate(() => {
      const t = (document.body?.innerText || "").replace(/\s+/g, " ");
      return {
        url: location.href,
        hasSaved: t.includes("保存成功") || t.includes("草稿箱"),
        draftHint: t.match(/草稿箱[^\s]{0,12}/)?.[0] || "",
      };
    });
    if (!afterSave.hasSaved) {
      return makeFallback("save_draft", "点击暂存离开后未检测到「保存成功」或草稿箱回执", await collectLightDiagnostics(page), {
        topicLogs,
        coverResult,
        afterSave,
      });
    }

    return { status: "ok", topicLogs, locationLog, coverResult, unlinkedActivities, afterSave };
  } catch (err) {
    return makeFallback(step, err, await collectLightDiagnostics(page));
  }
}

/**
 * 阶段 2：从小红书草稿箱复开同一条稿，回读所有字段与封面评估，留页交接。
 */
export async function xhsReopenAndVerify(page, job) {
  let step = "open_draft_box";
  try {
    await bringToFront(page);
    const fullTitle = job.xhs.title;
    const titlePrefix = fullTitle.slice(0, 10);

    const drawerHasItem = await page.evaluate(
      (prefix) => (document.body?.innerText || "").includes(prefix),
      titlePrefix
    );
    if (!drawerHasItem) {
      const draftTrigger = await page.evaluate(() => {
        const el = [...document.querySelectorAll("div, span, button, a")].find(
          (n) =>
            /^草稿箱/.test((n.innerText || "").trim()) &&
            n.getBoundingClientRect().height > 0 &&
            n.getBoundingClientRect().height < 60
        );
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      if (!draftTrigger) throw new Error("未在小红书页面找到「草稿箱」入口");
      await page.mouse.click(draftTrigger.x, draftTrigger.y, { label: "open XHS draft box" });
      await page.waitForTimeout(1500);
    }

    step = "reopen_item";
    const reopen = await page.evaluate(
      ({ full, prefix }) => {
        const rows = [...document.querySelectorAll('[class*="draft"], li, .item, .card, div')];
        const parseMatches = (needle) =>
          rows
            .map((r) => {
              const t = (r.innerText || "").replace(/\s+/g, " ");
              const tm = t.match(/保存于(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)?.[1] || "";
              const btn = [...r.querySelectorAll("button, a, span, div")].find(
                (el) => (el.textContent || "").trim() === "编辑"
              );
              return { r, t, tm, btn, len: t.length };
            })
            .filter((x) => x.t.includes(needle) && x.btn && x.len < 320)
            .sort((a, b) => b.tm.localeCompare(a.tm) || a.len - b.len);

        const exact = parseMatches(full);
        const matches = exact.length ? exact : parseMatches(prefix);
        const top = matches[0];
        if (top) {
          top.btn.click();
          return { ok: true, matchedBy: exact.length ? "fullTitle" : "prefix", savedAt: top.tm, rowText: top.t };
        }
        return { ok: false };
      },
      { full: fullTitle, prefix: titlePrefix }
    );
    if (!reopen.ok) throw new Error(`小红书草稿箱未找到含「${fullTitle}」的条目`);
    await page.waitForTimeout(3500);
    await muteAndPausePage(page);

    step = "verify";
    const verified = await page.evaluate(() => {
      const title = document.querySelector('input.d-text[placeholder*="填写标题"]')?.value || "";
      const count = (document.body?.innerText || "").match(/\d+\s*\/\s*20/)?.[0] || "";
      const ed = document.querySelector("div.tiptap.ProseMirror");
      const topics = [...(ed?.querySelectorAll("a.tiptap-topic") || [])].map((a) => {
        try {
          return JSON.parse(a.getAttribute("data-topic") || "{}").name || a.textContent?.trim();
        } catch {
          return a.textContent?.trim();
        }
      });
      const switches = [...document.querySelectorAll(".custom-switch-card")].map((el) => ({
        text: (el.innerText || "").replace(/\s+/g, " ").slice(0, 20),
        checked: !!el.querySelector('input[type="checkbox"]')?.checked,
      }));
      const decl = [...document.querySelectorAll(".d-select")].map((el) =>
        (el.innerText || "").replace(/\s+/g, " ").slice(0, 30)
      );
      const coverImgs = [...document.querySelectorAll('img.cover, .default--ai-cover-layout img, [class*="preview"] img')]
        .filter((i) => {
          const cls = (i.className || "").toString();
          if (/coverDetectTag|activity-cover|ai-cover-preview-card/i.test(cls)) return false;
          return i.naturalWidth >= 400 || (cls === "cover" && i.naturalWidth >= 200);
        })
        .sort((a, b) => (b.naturalWidth || 0) - (a.naturalWidth || 0))
        .map((img) => ({
          cls: (img.className || "").toString().slice(0, 30),
          nw: img.naturalWidth,
          nh: img.naturalHeight,
          ratio: Number((img.naturalWidth / img.naturalHeight).toFixed(3)),
          host: (() => {
            try {
              return new URL(img.currentSrc || img.src).host;
            } catch {
              return "";
            }
          })(),
        }));
      const txt = (document.body?.innerText || "").replace(/\s+/g, " ");
      const locDisplay = decl[1] || "";
      const selectedLocation = locDisplay && locDisplay !== "添加地点" && !locDisplay.includes("选择群聊") ? locDisplay : "";
      return {
        url: window.location.href,
        title,
        count,
        topics,
        location: selectedLocation,
        switches,
        decl,
        hasEvalPass: txt.includes("封面效果评估通过"),
        hasHD: txt.includes("高清视频"),
        stillUploading: txt.includes("上传中") || txt.includes("正在上传"),
        coverImgs: coverImgs.slice(0, 4),
      };
    });

    const linkedActivities = await inspectXhsLinkedActivities(page);
    verified.linkedActivities = linkedActivities.map((a) => a.name);

    const issues = [];
    if (verified.stillUploading) issues.push("复开后视频仍处于上传中状态");
    if (verified.title !== job.xhs.title) issues.push(`标题不一致: "${verified.title}"`);
    if (verified.topics.length < job.xhs.topics.length) {
      issues.push(`话题实体数量不足: 实得 ${verified.topics.length}/${job.xhs.topics.length}`);
    }
    if (job.xhs.location && job.xhs.location !== "不显示位置" && !verified.location) {
      issues.push(`小红书地点未生效: 期望包含「${job.xhs.location}」，当前仍为「添加地点」`);
    }
    if (!job.allowActivities && verified.linkedActivities.length > 0) {
      issues.push(`存在未授权关联活动: ${verified.linkedActivities.join("、")}，必须点击「取消关联」解除`);
    }
    const sched = verified.switches.find((s) => s.text.includes("定时"));
    if (sched?.checked) issues.push("定时发布开关被意外打开，必须关闭");
    const origSw = verified.switches.find((s) => s.text.includes("原创"));
    if (job.original && !origSw?.checked) issues.push("原创声明未勾选");
    const contentDecl = verified.decl[0] || "";
    if (job.aiGenerated && !contentDecl.includes("AI")) issues.push(`AI 声明未生效: "${contentDecl}"`);
    if (!job.aiGenerated && contentDecl.includes("AI")) issues.push(`误选了 AI 声明: "${contentDecl}"`);
    if (job.xhs.coverPath) {
      const mainCover = verified.coverImgs.find((c) => c.nw >= 400) || verified.coverImgs[0];
      if (mainCover) {
        if (job.xhs.coverRatio === "4x3" && mainCover.ratio < 1.15) {
          issues.push(`小红书 4:3 横封面比例异常 (ratio=${mainCover.ratio})，疑似仍被裁成 3:4`);
        } else if (job.xhs.coverRatio === "3x4" && mainCover.ratio > 0.9) {
          issues.push(`小红书 3:4 竖封面比例异常 (ratio=${mainCover.ratio})`);
        }
      }
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
