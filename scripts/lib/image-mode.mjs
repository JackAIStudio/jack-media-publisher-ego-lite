import {
  bringToFront,
  collectLightDiagnostics,
  makeFallback,
  makeHandoff,
  muteAndPausePage,
} from "./utils.mjs";
import { WECHAT_NO_LOCATION } from "./validate.mjs";

export const XHS_IMAGE_URL = "https://creator.xiaohongshu.com/publish/publish?target=image";
export const DOUYIN_IMAGE_URL =
  "https://creator.douyin.com/creator-micro/content/upload?default-tab=3&enter_from=publish";
export const WECHAT_IMAGE_URL = "https://channels.weixin.qq.com/platform/post/finderNewLifeCreate";
export const WECHAT_DRAFT_LIST_URL = "https://channels.weixin.qq.com/platform/post/draftListManager";
export const X_COMPOSE_URL = "https://x.com/compose/post";
export const BILI_DYNAMIC_URL = "https://t.bilibili.com/";

export const IMAGE_PLATFORM_URLS = {
  xhs: XHS_IMAGE_URL,
  douyin: DOUYIN_IMAGE_URL,
  wechat: WECHAT_IMAGE_URL,
  x: X_COMPOSE_URL,
  bilibili: BILI_DYNAMIC_URL,
};

function getImagePaths(job) {
  return (job.images || []).map((img) => img.path);
}

/**
 * 逐行写入多行正文（每行 insertText + Enter），避免富文本编辑器一次性插入换行产生异常字符（如抖音行首 *）或空段落堆叠。
 */
async function typeMultilineText(page, text) {
  const lines = String(text || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) {
      await page.keyboard.insertText(lines[i]);
    }
    await page.keyboard.press("Enter");
    await page.waitForTimeout(80);
  }
}

// ============================================================================
// 1. 小红书原生图文（?target=image）
// ============================================================================

async function inspectXhsLinkedActivities(page) {
  return page.evaluate(() => {
    const btns = [...document.querySelectorAll("button, a, span, div")].filter((el) => {
      if (el.children.length > 1) return false;
      const t = (el.innerText || el.textContent || "").trim();
      const r = el.getBoundingClientRect();
      return t === "取消关联" && r.width >= 12 && r.height >= 8 && r.height <= 64;
    });
    const leaf = btns.filter((el) => !btns.some((o) => o !== el && el.contains(o)));
    return leaf.map((el) => {
      let card = el.parentElement;
      for (let i = 0; i < 4 && card; i++) {
        const cr = card.getBoundingClientRect();
        if (cr.width > 120 && cr.height >= 40 && cr.height <= 160) break;
        card = card.parentElement;
      }
      const lines = (card?.innerText || "")
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s && s !== "取消关联");
      return { name: lines[0] || "未命名活动" };
    });
  });
}

async function unlinkXhsActivities(page) {
  const unlinked = [];
  for (let guard = 0; guard < 5; guard++) {
    const target = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button, a, span, div")].filter((el) => {
        if (el.children.length > 1) return false;
        const t = (el.innerText || el.textContent || "").trim();
        const r = el.getBoundingClientRect();
        return t === "取消关联" && r.width >= 12 && r.height >= 8 && r.height <= 64;
      });
      const leaf = btns.find((el) => !btns.some((o) => o !== el && el.contains(o)));
      if (!leaf) return null;
      leaf.scrollIntoView({ block: "center", behavior: "instant" });
      const r = leaf.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    if (!target) break;
    await page.waitForTimeout(200);
    await page.mouse.click(target.x, target.y, { label: "unlink XHS image auto activity" });
    unlinked.push("unlinked");
    await page.waitForTimeout(500);
  }
  return unlinked;
}

export async function xhsImageInspectAndInject(page, job) {
  await page.waitForSelector("input.upload-input", { state: "attached", timeout: 15000 }).catch(() => {});
  const info = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const user =
      document.querySelector(".account-name, .user-name, .name-box, .header-user-name")?.textContent?.trim() || "";
    const draftHint = text.match(/草稿箱[^\n]{0,12}/)?.[0] || "";
    const draftCount = Number(draftHint.match(/\((\d+)\)/)?.[1] ?? -1);
    const inp = document.querySelector("input.upload-input");
    return {
      url: location.href,
      user,
      draftHint,
      draftCount,
      hasUploadInput: !!inp,
      accept: inp?.accept || "",
    };
  });

  if (!info.url.includes("creator.xiaohongshu.com/publish") || !info.hasUploadInput) {
    return makeHandoff("login", "小红书未登录或未停留在图文发布页，请先登录或接管。", { info });
  }
  if (info.draftCount >= 100) {
    return makeHandoff("draft_quota", "小红书本地草稿箱已达 100 条容量上限，请先由作者决定清理哪些旧稿。", { info });
  }

  const paths = getImagePaths(job);
  await page.setInputFiles("input.upload-input", paths);
  return { status: "injected", user: info.user, draftHintBefore: info.draftHint, imageCount: paths.length };
}

export async function xhsImageFillAndSave(page, job) {
  let step = "wait_editor";
  try {
    await bringToFront(page);
    await page.waitForSelector('input.d-text[placeholder*="填写标题"]', { state: "visible", timeout: 25000 });
    await page.waitForTimeout(600);

    // 关键避坑：先关闭新手指引气泡「我知道了」，否则会拦截正文编辑器点击导致正文被吞
    step = "dismiss_guide";
    await page.click(".feature-guide__btn", { label: "dismiss XHS image guide", timeout: 2500 }).catch(async () => {
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button, span, div")].find(
          (el) => (el.innerText || "").trim() === "我知道了" && el.getBoundingClientRect().height > 0
        );
        btn?.click();
      });
    });
    await page.waitForTimeout(350);

    // 1. 标题
    step = "title";
    await page.fill('input.d-text[placeholder*="填写标题"]', job.xhs.title);
    await page.waitForTimeout(250);

    // 2. 正文与真实话题实体
    step = "body_and_topics";
    const edTop = await page.evaluate(() => {
      const ed = document.querySelector("div.tiptap.ProseMirror");
      if (!ed) return null;
      ed.scrollIntoView({ block: "center" });
      ed.focus();
      const r = ed.getBoundingClientRect();
      return { x: Math.round(r.left + 40), y: Math.round(r.top + 20) };
    });
    if (!edTop) throw new Error("未找到小红书图文正文编辑器 div.tiptap.ProseMirror");
    await page.waitForTimeout(200);
    await page.mouse.click(edTop.x, edTop.y, { label: "focus XHS image body" });
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);

    if (job.xhs.description) {
      await typeMultilineText(page, job.xhs.description);
      await page.waitForTimeout(200);
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
          (w) =>
            [...document.querySelectorAll(".tippy-box .item")].some((el) =>
              (el.innerText || "").toLowerCase().includes(w.toLowerCase())
            ),
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
        return { word: w, chosen: chosen?.name || null };
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
      await page.click(".original-wrapper .d-switch", { label: "enable XHS image original" });
      await page.waitForTimeout(600);
      const hasModal = await page.evaluate(() => !!document.querySelector(".originalContainer"));
      if (hasModal) {
        await page.click(".originalContainer .d-checkbox-simulator", { label: "agree XHS image original" });
        await page.waitForTimeout(250);
        await page.evaluate(() => {
          const btn = [...document.querySelectorAll(".originalContainer button, button")].find(
            (b) => (b.innerText || "").trim() === "声明原创" && b.getBoundingClientRect().height > 0
          );
          btn?.click();
        });
        await page.waitForTimeout(500);
      }
    }

    // 4. 内容类型声明（二元：含 AI 选「笔记含AI合成内容」，非 AI 留空）
    step = "ai_declaration";
    if (job.aiGenerated) {
      await page.evaluate(() => {
        const el = [...document.querySelectorAll(".d-select")].find((n) =>
          (n.innerText || "").includes("内容类型声明")
        );
        el?.scrollIntoView({ block: "center" });
      });
      await page.waitForTimeout(250);
      await page.click('text="添加内容类型声明"', { label: "open XHS image content decl" }).catch(async () => {
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
      if (!aiPicked) throw new Error("未在小红书图文内容类型声明下拉中找到「笔记含AI合成内容」");
      await page.waitForTimeout(450);
    }

    // 5. 可选地点
    step = "location";
    let locationLog = { skipped: true, target: "", selected: "" };
    if (job.xhs.location && job.xhs.location !== WECHAT_NO_LOCATION) {
      const targetLoc = job.xhs.location;
      const queryLoc = job.xhs.locationQuery || targetLoc;
      await page.evaluate(() => {
        const el = [...document.querySelectorAll("div, span, input")].find(
          (n) => (n.innerText || n.placeholder || "").trim() === "添加地点" && n.getBoundingClientRect().height > 8
        );
        el?.scrollIntoView({ block: "center", behavior: "instant" });
      });
      await page.waitForTimeout(300);
      await page.click('text="添加地点"', { label: "focus XHS image location", timeout: 6000 });
      await page.waitForTimeout(500);
      await page.keyboard.type(queryLoc, { delay: 65 });
      await page.waitForTimeout(1800);

      const picked = await page.evaluate((target) => {
        const isSubPoi = (t) =>
          /(停车场|接送点|招商办公室|便利店|银泰百货|[A-Z]栋|\(.*(?:店|门|出口)\)|（.*(?:店|门|出口)）)/.test(t);
        const els = [
          ...document.querySelectorAll(
            '.d-popover li, .d-dropdown li, [class*="poi"], [class*="location"] [class*="item"], [role="option"], .d-select-dropdown div, div'
          ),
        ].filter((el) => {
          const r = el.getBoundingClientRect();
          const t = (el.innerText || "").trim();
          if (r.width < 80 || r.height < 18 || r.height > 95) return false;
          if (!t || t.length > 80 || t.includes("\n")) return false;
          if (/^(添加地点|标记地点或标记朋友)$/.test(t)) return false;
          return t.includes(target);
        });
        const leaf = els.filter((el) => !els.some((o) => o !== el && el.contains(o)));
        const scored = leaf
          .map((el) => {
            const name = (el.innerText || "").trim();
            const r = el.getBoundingClientRect();
            let score = name === target ? 100 : name.startsWith(target) ? 60 : 40;
            if (!isSubPoi(name)) score += 30;
            score -= Math.min(20, Math.abs(name.length - target.length));
            return { name, score, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          })
          .sort((a, b) => b.score - a.score);
        return { best: scored[0] || null, candidates: scored.slice(0, 6).map((s) => s.name) };
      }, targetLoc);

      if (!picked.best) {
        throw new Error(`小红书地点搜索「${queryLoc}」未找到匹配「${targetLoc}」的 POI`);
      }
      await page.mouse.click(picked.best.x, picked.best.y, { label: "select XHS image location POI" });
      await page.waitForTimeout(700);
      locationLog = { skipped: false, target: targetLoc, selected: picked.best.name };
    }

    // 6. 解除因话题自动关联的活动
    step = "unlink_activities";
    let unlinkedActivities = [];
    if (!job.allowActivities) {
      await page.waitForTimeout(250);
      unlinkedActivities = await unlinkXhsActivities(page);
    }

    // 7. 暂存离开（图文页 <xhs-publish-btn> 为 closed shadow DOM，优先 full_page snapshot 取 ref）
    step = "save_draft";
    const snap = await page.snapshot({ scope: "full_page" });
    const m = snap.match(/\[ref=(\d+)[^\]]*\]\n\s+text "暂存离开"/) || snap.match(/button "暂存离开" \[ref=(\d+)/);
    if (m) {
      await page.click(`@${m[1]}`, { label: "save XHS image draft by ref" });
    } else {
      await page.click('text="暂存离开"', { label: "save XHS image draft fallback", timeout: 5000 });
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
      return makeFallback("save_draft", "小红书图文点击暂存离开后未检测到草稿箱回执", await collectLightDiagnostics(page), {
        topicLogs,
        afterSave,
      });
    }

    return { status: "ok", topicLogs, locationLog, unlinkedActivities, afterSave };
  } catch (err) {
    return makeFallback(step, err, await collectLightDiagnostics(page));
  }
}

export async function xhsImageReopenAndVerify(page, job) {
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
      if (!draftTrigger) throw new Error("未在小红书图文页找到「草稿箱」入口");
      await page.mouse.click(draftTrigger.x, draftTrigger.y, { label: "open XHS image draft box" });
      await page.waitForTimeout(1600);
    }

    // 确保位于「图文笔记」草稿 Tab
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll("div, span, button, a")].find(
        (el) => el.children.length === 0 && /^图文笔记/.test((el.innerText || "").trim()) && el.getBoundingClientRect().height > 0
      );
      tab?.click();
    });
    await page.waitForTimeout(500);

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
            .filter((x) => x.t.includes(needle) && x.btn && x.len < 360)
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
    if (!reopen.ok) throw new Error(`小红书图文草稿箱未找到含「${fullTitle}」的条目`);
    await page.waitForTimeout(3200);
    await page.click(".feature-guide__btn", { label: "dismiss XHS image guide after reopen", timeout: 1500 }).catch(() => {});

    step = "verify";
    const verified = await page.evaluate(() => {
      const title = document.querySelector('input.d-text[placeholder*="填写标题"]')?.value || "";
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
      const imgs = [...document.querySelectorAll("img")]
        .filter((i) => i.naturalWidth >= 400 && !/fe-static/.test(i.currentSrc || i.src || ""))
        .map((img) => ({
          cls: (img.className || "").toString().slice(0, 30),
          nw: img.naturalWidth,
          nh: img.naturalHeight,
        }));
      const locDisplay = decl[1] || "";
      const selectedLocation =
        locDisplay && locDisplay !== "添加地点" && !locDisplay.includes("选择群聊") ? locDisplay : "";
      return {
        url: window.location.href,
        title,
        bodyText: (ed?.innerText || "").trim(),
        topics,
        location: selectedLocation,
        switches,
        decl,
        imgs: imgs.slice(0, 6),
      };
    });

    const linkedActivities = await inspectXhsLinkedActivities(page);
    verified.linkedActivities = linkedActivities.map((a) => a.name);

    const issues = [];
    if (verified.title !== job.xhs.title) issues.push(`标题不一致: "${verified.title}"`);
    if (job.xhs.description && !verified.bodyText.includes(job.xhs.description.slice(0, 12))) {
      issues.push("复开后正文缺失（疑似聚焦被新手指引弹窗拦截）");
    }
    if (verified.topics.length < job.xhs.topics.length) {
      issues.push(`话题实体数量不足: 实得 ${verified.topics.length}/${job.xhs.topics.length}`);
    }
    if (job.xhs.location && job.xhs.location !== WECHAT_NO_LOCATION && !verified.location) {
      issues.push(`小红书地点未生效: 期望「${job.xhs.location}」`);
    }
    if (!job.allowActivities && verified.linkedActivities.length > 0) {
      issues.push(`存在未授权关联活动: ${verified.linkedActivities.join("、")}`);
    }
    const sched = verified.switches.find((s) => s.text.includes("定时"));
    if (sched?.checked) issues.push("定时发布开关被意外打开，必须关闭");
    const origSw = verified.switches.find((s) => s.text.includes("原创"));
    if (job.original && !origSw?.checked) issues.push("原创声明未勾选");
    const contentDecl = verified.decl[0] || "";
    if (job.aiGenerated && !contentDecl.includes("AI")) issues.push(`AI 声明未生效: "${contentDecl}"`);
    if (!job.aiGenerated && contentDecl.includes("AI")) issues.push(`误选了 AI 声明: "${contentDecl}"`);
    if (!verified.imgs.length) issues.push("复开后未检测到有效上传图片（naturalWidth >= 400）");

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

// ============================================================================
// 2. 抖音原生图文（default-tab=3 / 发布图文）
// ============================================================================

export async function douyinImageInspectAndInject(page, job) {
  await bringToFront(page);
  await page.waitForSelector('input[type="file"]', { state: "attached", timeout: 15000 }).catch(() => {});

  // 确认位于「发布图文」Tab
  let imgIdx = await page.evaluate(() => {
    const inps = [...document.querySelectorAll('input[type="file"]')];
    return inps.findIndex((i) => (i.accept || "").includes("image"));
  });
  if (imgIdx < 0) {
    await page.click('text="发布图文"', { label: "switch DY to image tab" }).catch(() => {});
    await page.waitForTimeout(2000);
    imgIdx = await page.evaluate(() => {
      const inps = [...document.querySelectorAll('input[type="file"]')];
      return inps.findIndex((i) => (i.accept || "").includes("image"));
    });
  }

  const info = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const hasContinue = text.includes("继续编辑") || text.includes("未发布的图文");
    const idx = text.indexOf("未发布");
    const continueSnippet = hasContinue ? text.slice(Math.max(0, idx - 20), idx + 120) : "";
    return { url: location.href, hasContinue, continueSnippet };
  });

  if (!info.url.includes("creator.douyin.com/creator-micro")) {
    return makeHandoff("login", "抖音创作者中心未登录或已跳转登录页，请先登录。", { info });
  }
  if (info.hasContinue && !job.douyin.allowContinueExisting) {
    return makeHandoff(
      "continue_edit_conflict",
      "抖音图文上传页存在上次未发布的图文「继续编辑」入口；为防覆盖其他作品，已暂停注入，请先辨认并确认。",
      { continueSnippet: info.continueSnippet }
    );
  }
  if (imgIdx < 0) {
    return makeFallback("inject", "未在抖音发布图文页找到接收图片的 input[type=file]", await collectLightDiagnostics(page));
  }

  const paths = getImagePaths(job);
  await page.setInputFiles(`input[type="file"] >> nth=${imgIdx}`, paths);
  return { status: "injected", hadContinue: info.hasContinue, imageCount: paths.length };
}

export async function douyinImageFillAndSave(page, job) {
  let step = "wait_editor";
  try {
    await bringToFront(page);
    await page.waitForSelector('input.semi-input[placeholder*="作品标题"]', { state: "visible", timeout: 25000 });
    await muteAndPausePage(page);

    // 1. 标题（抖音图文上限 20）
    step = "title";
    await page.fill('input.semi-input[placeholder*="作品标题"]', job.douyin.title);
    await page.waitForTimeout(250);

    // 2. 正文（逐行 insertText + Enter，避免一次性含 \n 产生异常 * 字符）+ 话题实体
    step = "body_and_topics";
    await page.evaluate(() =>
      document.querySelector("div.zone-container.editor-kit-container")?.scrollIntoView({ block: "center" })
    );
    await page.waitForTimeout(250);
    await page.click("div.zone-container.editor-kit-container", { label: "focus DY image desc" });
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);

    if (job.douyin.description) {
      await typeMultilineText(page, job.douyin.description);
      await page.waitForTimeout(200);
    }

    const topicLogs = [];
    for (const word of job.douyin.topics) {
      await page.click('text="#添加话题"', { label: `DY image add topic ${word}` });
      await page.waitForTimeout(350);
      await page.keyboard.type(word, { delay: 50 });
      await page.waitForTimeout(900);

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
        await page.mouse.click(pick.x, pick.y, { label: `DY image pick topic ${pick.firstLine}` });
        topicLogs.push({ word, chosen: pick.firstLine });
      } else {
        await page.keyboard.press("Enter");
        topicLogs.push({ word, chosen: "enter_fallback" });
      }
      await page.waitForTimeout(420);
    }

    // 3. 自主声明
    step = "self_declaration";
    const targetDecl = job.aiGenerated ? "内容由AI生成" : "无需添加自主声明";
    await page.evaluate(() => document.querySelector(".selectBox-buZRzi")?.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(250);
    const declBefore = await page.evaluate(() => document.querySelector(".selectBox-buZRzi")?.innerText?.trim() || "");
    if (!declBefore.includes(targetDecl)) {
      await page.click(".selectBox-buZRzi", { label: "open DY image self declaration" });
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
      if (!optRect) throw new Error(`未在抖音图文自主声明弹窗中找到「${targetDecl}」`);
      await page.mouse.click(optRect.x, optRect.y, { label: `select DY image ${targetDecl}` });
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('.semi-modal button, [role="dialog"] button')].find(
          (b) => (b.innerText || "").trim() === "确定" && b.getBoundingClientRect().height > 0
        );
        btn?.click();
      });
      await page.waitForTimeout(450);
    }

    // 4. 可选背景音乐（点右侧 .action-Q1y01k 或「修改音乐」-> 直接搜歌框搜曲目）
    step = "music";
    let musicLog = { skipped: true };
    if (job.douyin.music?.action === "search" && job.douyin.music.query) {
      const musicTrigger = await page.evaluate(() => {
        const el =
          document.querySelector(".action-Q1y01k") ||
          [...document.querySelectorAll("div, span, button")].find(
            (n) => (n.innerText || "").trim() === "修改音乐" && n.getBoundingClientRect().height > 0 && n.getBoundingClientRect().height < 60
          );
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      if (!musicTrigger) throw new Error("未在抖音图文页找到右侧「选择音乐 / 修改音乐」按钮");
      await page.waitForTimeout(250);
      await page.mouse.click(musicTrigger.x, musicTrigger.y, { label: "open DY image music drawer" });
      await page.waitForTimeout(1800);

      const searchBox = await page.evaluate(() => {
        const inp = [...document.querySelectorAll("input")].find((i) => {
          const r = i.getBoundingClientRect();
          return r.width > 80 && r.height > 15 && /音乐|搜索|歌/.test(i.placeholder || "");
        });
        if (!inp) return null;
        const r = inp.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      if (!searchBox) throw new Error("抖音音乐抽屉未检测到「搜索音乐」输入框");

      await page.mouse.click(searchBox.x, searchBox.y, { label: "focus DY music search" });
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.press("Backspace");
      await page.keyboard.insertText(job.douyin.music.query);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(2200);

      const songs = await page.evaluate(() => {
        const box =
          document.querySelector(".music-collection-container-cTsB7J") ||
          document.querySelector('[class*="music-list"], [class*="music-search"]') ||
          document.body;
        const rows = [...box.querySelectorAll("div")].filter((el) => {
          const r = el.getBoundingClientRect();
          const t = (el.innerText || "").trim();
          return r.height >= 44 && r.height <= 98 && r.width > 220 && r.left > 700 && /\d{2}:\d{2}/.test(t) && t.length < 160;
        });
        const leaf = rows.filter((el) => !rows.some((o) => o !== el && el.contains(o)));
        return leaf.slice(0, 8).map((el) => {
          const r = el.getBoundingClientRect();
          return {
            text: (el.innerText || "").replace(/\s+/g, " ").trim(),
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
          };
        });
      });

      const prefer = job.douyin.music.prefer || "";
      const chosen =
        (prefer && songs.find((s) => s.text.includes(prefer))) ||
        songs.find((s) => !/原声|DJ|搞笑|伤感|鬼畜|离别/.test(s.text)) ||
        songs[0];
      if (!chosen) throw new Error(`抖音搜索音乐「${job.douyin.music.query}」未返回候选曲目`);

      await page.mouse.move(chosen.x, chosen.y, { label: "hover DY searched music" });
      await page.waitForTimeout(550);
      const useBtn = await page.evaluate((yTarget) => {
        const b = [...document.querySelectorAll("button, span, div")].find((el) => {
          const t = (el.innerText || "").trim();
          const r = el.getBoundingClientRect();
          return (t === "使用" || t === "使用音乐") && r.height > 14 && r.height < 55 && Math.abs(r.top + r.height / 2 - yTarget) < 55;
        });
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }, chosen.y);
      if (!useBtn) throw new Error(`抖音音乐「${chosen.text}」未出现「使用」按钮`);
      await page.mouse.click(useBtn.x, useBtn.y, { label: "apply DY searched music" });
      await page.waitForTimeout(1400);
      await muteAndPausePage(page);
      musicLog = { skipped: false, query: job.douyin.music.query, selected: chosen.text };
    }

    // 5. 可选地理位置
    step = "location";
    let locationLog = { skipped: true, target: "", selected: "" };
    if (job.douyin.location && job.douyin.location !== WECHAT_NO_LOCATION) {
      const targetLoc = job.douyin.location;
      const queryLoc = job.douyin.locationQuery || targetLoc;
      await page.evaluate(() => {
        const el = [...document.querySelectorAll("div, span, input")].find(
          (n) => /输入.*位置/.test((n.innerText || n.placeholder || "").trim()) && n.getBoundingClientRect().height > 8
        );
        el?.scrollIntoView({ block: "center", behavior: "instant" });
      });
      await page.waitForTimeout(300);
      await page.click('text="输入地理位置"', { label: "focus DY image location", timeout: 4000 }).catch(async () => {
        await page.click('text="输入相关位置，让更多人看到你的作品"', { label: "focus DY image location alt", timeout: 4000 });
      });
      await page.waitForTimeout(450);
      await page.keyboard.type(queryLoc, { delay: 65 });
      await page.waitForTimeout(1800);

      const picked = await page.evaluate((target) => {
        const isSubPoi = (t) => /(停车场|接送点|招商办公室|便利店|[A-Z]栋|\(.*(?:店|门|出口)\)|（.*(?:店|门|出口)）)/.test(t);
        const nodes = [...document.querySelectorAll("div, li, span")].filter((el) => {
          const r = el.getBoundingClientRect();
          const t = (el.innerText || "").trim();
          if (r.width < 60 || r.height < 16 || r.height > 90) return false;
          if (!t || t.length > 80 || t.includes("\n")) return false;
          if (/^(本地|国内|国际|输入地理位置|点击加载更多|添加标签|位置)$/.test(t)) return false;
          return t.includes(target);
        });
        const leaf = nodes.filter((el) => !nodes.some((o) => o !== el && el.contains(o)));
        const scored = leaf
          .map((el) => {
            const name = (el.innerText || "").trim();
            const r = el.getBoundingClientRect();
            let score = name === target ? 100 : name.startsWith(target) ? 60 : 40;
            if (!isSubPoi(name)) score += 30;
            score -= Math.min(20, Math.abs(name.length - target.length));
            return { name, score, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          })
          .sort((a, b) => b.score - a.score);
        return { best: scored[0] || null };
      }, targetLoc);

      if (!picked.best) {
        throw new Error(`抖音图文地理位置搜索「${queryLoc}」未找到匹配「${targetLoc}」的 POI`);
      }
      await page.mouse.click(picked.best.x, picked.best.y, { label: "select DY image location POI" });
      await page.waitForTimeout(800);
      locationLog = { skipped: false, target: targetLoc, selected: picked.best.name };
    }

    // 6. 暂存离开
    step = "save_draft";
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => (b.innerText || "").trim() === "暂存离开" && b.getBoundingClientRect().height > 0
      );
      btn?.scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(300);
    await page.click('button:has-text("暂存离开")', { label: "save DY image draft" });
    await page.waitForTimeout(3500);

    const afterSave = await page.evaluate(() => ({
      url: location.href,
      hasContinue: (document.body?.innerText || "").includes("继续编辑"),
    }));
    if (!afterSave.hasContinue) {
      return makeFallback("save_draft", "抖音图文点击暂存离开后未检测到「继续编辑」入口", await collectLightDiagnostics(page), {
        topicLogs,
        musicLog,
        afterSave,
      });
    }

    return { status: "ok", topicLogs, musicLog, locationLog, afterSave };
  } catch (err) {
    return makeFallback(step, err, await collectLightDiagnostics(page));
  }
}

export async function douyinImageReopenAndVerify(page, job) {
  let step = "reopen";
  try {
    await bringToFront(page);
    const hasContinue = await page.evaluate(() => (document.body?.innerText || "").includes("继续编辑"));
    if (!hasContinue && !(await page.url()).includes("enter_from=draft")) {
      await page.goto(DOUYIN_IMAGE_URL, { timeout: 20000 });
      await page.waitForTimeout(2500);
    }
    if (await page.evaluate(() => (document.body?.innerText || "").includes("继续编辑"))) {
      await page.click('text="继续编辑"', { label: "reopen DY image draft" });
      await page.waitForTimeout(3500);
    }
    await muteAndPausePage(page);

    step = "verify";
    const verified = await page.evaluate(() => {
      const title = document.querySelector('input.semi-input[placeholder*="作品标题"]')?.value || "";
      const ed = document.querySelector("div.zone-container.editor-kit-container");
      const bodyText = (ed?.innerText || "").trim();
      const mentions = [...(ed?.querySelectorAll("[data-mention]") || [])].map((e) => e.textContent?.trim());
      const decl = document.querySelector(".selectBox-buZRzi")?.innerText?.trim() || "";
      const music = document.querySelector(".sub-desc-title-yp0uUv")?.innerText?.trim() || "";
      const uploadedImgs = [...document.querySelectorAll("img")]
        .filter((i) => i.naturalWidth >= 400 && /douyin\.com|byteimg\.com|p\d-creator/.test(i.currentSrc || i.src || ""))
        .map((i) => ({ nw: i.naturalWidth, nh: i.naturalHeight }));
      const txt = (document.body?.innerText || "").replace(/\s+/g, " ");
      return {
        url: window.location.href,
        title,
        count: txt.match(/\d+\/20/)?.[0] || "",
        bodyText,
        hasStarBug: bodyText.includes("*"),
        mentions,
        decl,
        music,
        uploadedImgCount: uploadedImgs.length,
        sampleImg: uploadedImgs[0] || null,
      };
    });

    const issues = [];
    const expectedDecl = job.aiGenerated ? "内容由AI生成" : "无需添加自主声明";
    if (verified.title !== job.douyin.title) issues.push(`抖音图文标题不一致: 期望「${job.douyin.title}」，实际「${verified.title}」`);
    if (verified.hasStarBug) issues.push("抖音图文正文检出异常星号 *（请改用逐行输入重写）");
    if (verified.mentions.length < job.douyin.topics.length) {
      issues.push(`抖音话题实体数量不足: ${verified.mentions.length}/${job.douyin.topics.length}`);
    }
    if (!verified.decl.includes(expectedDecl)) {
      issues.push(`抖音自主声明不符: 期望「${expectedDecl}」，实际「${verified.decl}」`);
    }
    if (job.douyin.music?.action === "search" && !verified.music) {
      issues.push(`抖音图文背景音乐未生效（期望搜索「${job.douyin.music.query}」）`);
    }
    if (verified.uploadedImgCount === 0) {
      issues.push("复开后未检测到已上传图文图片");
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

// ============================================================================
// 3. 微信视频号原生图文（finderNewLifeCreate · wujie shadow DOM）
// ============================================================================

export async function wechatImageInspectAndInject(page, job) {
  await bringToFront(page);
  await page
    .waitForFunction(
      () => {
        const sr = document.querySelector("wujie-app")?.shadowRoot;
        return !!(sr && (sr.querySelector(".ant-upload-drag-container") || sr.querySelector('input[type="file"]')));
      },
      undefined,
      { timeout: 20000 }
    )
    .catch(() => {});

  const info = await page.evaluate(() => {
    const sr = document.querySelector("wujie-app")?.shadowRoot;
    const user =
      document.querySelector(".finder-nickname, .account-name, .name")?.textContent?.trim() ||
      (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 40);
    const drag = sr?.querySelector(".ant-upload-drag-container") || sr?.querySelector(".ant-upload-drag");
    const r = drag?.getBoundingClientRect();
    return {
      url: location.href,
      user,
      hasShadow: !!sr,
      uploadRect: r && r.width > 20 ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null,
    };
  });

  if (!info.url.includes("channels.weixin.qq.com/platform/post/finderNewLifeCreate") || !info.hasShadow) {
    return makeHandoff("login", "微信视频号未登录或图文发表页未加载，请先扫码登录。", { info });
  }
  if (!info.uploadRect) {
    return makeFallback("inject", "未找到微信视频号图文 .ant-upload-drag-container 上传区", await collectLightDiagnostics(page, true));
  }

  // 关键实测：wujie 内 ant-upload 直接 setInputFiles 静默失效，必须走 waitForFileChooser + 点击上传区
  const paths = getImagePaths(job);
  const chooserPromise = page.waitForFileChooser({ timeout: 10000 });
  await page.mouse.click(info.uploadRect.x, info.uploadRect.y, { label: "open WeChat image file chooser" });
  const chooser = await chooserPromise;
  await chooser.setFiles(paths);
  await page.waitForTimeout(3500);
  await muteAndPausePage(page);

  return { status: "injected", user: info.user, imageCount: paths.length };
}

export async function wechatImageFillAndSave(page, job) {
  let step = "wait_image_ready";
  try {
    await bringToFront(page);
    await muteAndPausePage(page);

    await page
      .waitForFunction(
        () => {
          const root = document.querySelector("wujie-app")?.shadowRoot;
          if (!root) return false;
          const img = root.querySelector("img.slider-img");
          const txt = root.body?.innerText || "";
          return !!img && img.naturalWidth >= 100 && !txt.includes("上传中");
        },
        undefined,
        { timeout: 30000 }
      )
      .catch(() => {});
    await muteAndPausePage(page);

    // 1. 独立图文标题（≤ 22 字符）
    step = "title";
    await page.fill('input[placeholder*="填写标题"]', job.wechat.title);
    await page.waitForTimeout(250);

    // 2. 图文描述（正文 + #话题）
    step = "description";
    await page.click("div.input-editor", { label: "focus WeChat image desc" });
    await page.waitForTimeout(200);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.keyboard.insertText(job.wechat.description);
    await page.waitForTimeout(600);

    // 3. 位置（视频号图文默认强带本机城市定位，未指定时必须切为「不显示位置」）
    step = "location";
    const targetLoc = job.wechat.location || WECHAT_NO_LOCATION;
    const searchLocQuery = job.wechat.locationQuery || targetLoc;
    const currentLoc = await page.evaluate(() => {
      const root = document.querySelector("wujie-app")?.shadowRoot || document;
      root.querySelector(".post-position-wrap")?.scrollIntoView({ block: "center" });
      return (
        root.querySelector(
          ".post-position-wrap .location-name, .post-position-wrap .not-display, .post-position-wrap .position-display"
        )?.innerText || ""
      ).trim();
    });
    await page.waitForTimeout(250);

    if (currentLoc !== targetLoc) {
      await page.click(".post-position-wrap .position-display", { label: "open WeChat image location" }).catch(async () => {
        await page.click(".post-position-wrap", { label: "open WeChat image location wrap" });
      });
      await page.waitForTimeout(650);

      if (targetLoc === WECHAT_NO_LOCATION) {
        await page.click('text="不显示位置"', { label: "select WeChat image no location", timeout: 4000 }).catch(async () => {
          await page.evaluate(() => {
            const root = document.querySelector("wujie-app")?.shadowRoot || document;
            const item = [
              ...root.querySelectorAll(".location-filter-wrap .option-item, .location-filter-wrap .location-item"),
            ].find((el) => (el.querySelector(".name")?.innerText || el.innerText || "").trim() === "不显示位置");
            item?.click();
          });
        });
      } else {
        await page.fill('.location-filter-wrap input[placeholder*="搜索附近位置"]', searchLocQuery);
        await page.waitForTimeout(250);
        await page
          .click(".location-filter-wrap .weui-desktop-search__btn", { label: `search WeChat image POI ${searchLocQuery}` })
          .catch(async () => page.keyboard.press("Enter"));
        await page.waitForTimeout(1600);
        const picked = await page.evaluate((loc) => {
          const root = document.querySelector("wujie-app")?.shadowRoot || document;
          const items = [
            ...root.querySelectorAll(".location-filter-wrap .option-item, .location-filter-wrap .location-item"),
          ].filter((el) => el.getBoundingClientRect().height > 0);
          const exact = items.find((el) => (el.querySelector(".name")?.innerText || "").trim() === loc);
          if (!exact) return { found: false };
          exact.scrollIntoView({ block: "nearest" });
          const r = exact.getBoundingClientRect();
          return { found: true, x: Math.round(r.left + Math.min(80, r.width / 2)), y: Math.round(r.top + r.height / 2) };
        }, targetLoc);
        if (!picked.found) throw new Error(`微信视频号图文位置搜索未精确命中「${targetLoc}」`);
        await page.mouse.click(picked.x, picked.y, { label: `select WeChat image POI ${targetLoc}` });
      }
      await page.waitForTimeout(550);
    }

    // 4. 背景音乐（防系统自动乱配不相关 BGM；搜索后必须点行内「选择」按钮而非只点 .song-info）
    step = "music";
    let musicLog = { action: job.wechat.music?.action || "unset" };
    const musicCfg = job.wechat.music || { action: "unset" };
    if (musicCfg.action === "none" || (musicCfg.action === "search" && musicCfg.query)) {
      const bgmTrigger = await page.evaluate(() => {
        const root = document.querySelector("wujie-app")?.shadowRoot || document;
        const wrap =
          root.querySelector(".bgm-form-content-wrap")?.closest(".link-display-wrap") ||
          root.querySelector(".bgm-form-content-wrap");
        if (!wrap) return null;
        wrap.scrollIntoView({ block: "center" });
        const r = wrap.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      if (!bgmTrigger) throw new Error("未在微信视频号图文页找到背景音乐触发器 .bgm-form-content-wrap");
      await page.waitForTimeout(250);
      await page.mouse.click(bgmTrigger.x, bgmTrigger.y, { label: "open WeChat image BGM dropdown" });
      await page.waitForTimeout(1000);

      if (musicCfg.action === "none") {
        const noneBtn = await page.evaluate(() => {
          const root = document.querySelector("wujie-app")?.shadowRoot || document;
          const optBox = root.querySelector('input[placeholder*="搜索歌名"]')?.closest(".link-list-options");
          const el = [...(optBox?.querySelectorAll("div, li, span") || [])].find(
            (n) => (n.innerText || "").trim() === "不添加音乐" && n.getBoundingClientRect().height > 0
          );
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        });
        if (!noneBtn) throw new Error("微信视频号背景音乐面板未找到「不添加音乐」");
        await page.mouse.click(noneBtn.x, noneBtn.y, { label: "select WeChat no BGM" });
        await page.waitForTimeout(700);
        musicLog.selected = "不添加音乐";
      } else {
        const sBox = await page.evaluate(() => {
          const root = document.querySelector("wujie-app")?.shadowRoot || document;
          const inp = root.querySelector('input[placeholder*="搜索歌名"]');
          const btn = inp?.closest(".weui-desktop-search")?.querySelector(".weui-desktop-search__btn");
          const r = inp?.getBoundingClientRect();
          const br = btn?.getBoundingClientRect();
          return {
            ix: r ? Math.round(r.left + r.width / 2) : 0,
            iy: r ? Math.round(r.top + r.height / 2) : 0,
            bx: br ? Math.round(br.left + br.width / 2) : 0,
            by: br ? Math.round(br.top + br.height / 2) : 0,
          };
        });
        if (!sBox.ix) throw new Error("微信视频号背景音乐搜索框未展开");
        await page.mouse.click(sBox.ix, sBox.iy, { label: "focus WeChat BGM search" });
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.press("Backspace");
        await page.keyboard.type(musicCfg.query, { delay: 80 });
        await page.waitForTimeout(250);
        if (sBox.bx > 0) await page.mouse.click(sBox.bx, sBox.by, { label: "search WeChat BGM" });
        await page.keyboard.press("Enter");
        await page.waitForTimeout(2400);

        const rowPos = await page.evaluate((prefer) => {
          const root = document.querySelector("wujie-app")?.shadowRoot || document;
          const optBox = root.querySelector('input[placeholder*="搜索歌名"]')?.closest(".link-list-options");
          if (!optBox) return null;
          const infos = [...optBox.querySelectorAll(".song-info")].filter((el) => el.getBoundingClientRect().height > 15);
          const pickInfo =
            (prefer && infos.find((el) => (el.innerText || "").includes(prefer))) ||
            infos.find((el) => !/伤感|悲伤|哭|DJ|用餐|离别/.test(el.innerText || "")) ||
            infos[0];
          if (!pickInfo) return null;
          let row = pickInfo.parentElement;
          for (let i = 0; i < 4 && row && row !== optBox; i++) {
            if ([...row.querySelectorAll("*")].some((el) => (el.textContent || "").trim() === "选择")) break;
            row = row.parentElement;
          }
          const r = (row || pickInfo).getBoundingClientRect();
          return {
            name: (pickInfo.innerText || "").replace(/\s+/g, " ").trim(),
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
          };
        }, musicCfg.prefer || "");

        if (!rowPos) throw new Error(`微信视频号搜索音乐「${musicCfg.query}」无结果`);
        await page.mouse.move(rowPos.x, rowPos.y, { label: "hover WeChat BGM song row" });
        await page.waitForTimeout(500);

        const selBtn = await page.evaluate((songName) => {
          const root = document.querySelector("wujie-app")?.shadowRoot || document;
          const optBox = root.querySelector('input[placeholder*="搜索歌名"]')?.closest(".link-list-options");
          if (!optBox) return null;
          const info = [...optBox.querySelectorAll(".song-info")].find((el) =>
            (el.innerText || "").replace(/\s+/g, " ").includes(songName.slice(0, 10))
          );
          let row = info?.parentElement;
          for (let i = 0; i < 4 && row && row !== optBox; i++) {
            if ([...row.querySelectorAll("*")].some((el) => (el.textContent || "").trim() === "选择")) break;
            row = row.parentElement;
          }
          const btn = [...(row || optBox).querySelectorAll("button, a, span, div")].find(
            (el) => el.children.length === 0 && (el.textContent || "").trim() === "选择"
          );
          if (!btn) return null;
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
          btn.click();
          return { clickedViaDom: true };
        }, rowPos.name);
        if (!selBtn) throw new Error(`微信视频号歌曲「${rowPos.name}」未找到「选择」按钮`);
        if (selBtn.x) await page.mouse.click(selBtn.x, selBtn.y, { label: "select WeChat BGM row" });
        await page.waitForTimeout(1000);
        musicLog.selected = rowPos.name;
      }

      // 确保下拉面板已收起，避免遮挡下方「视频标注」和「保存草稿」
      await page.evaluate(() => {
        const root = document.querySelector("wujie-app")?.shadowRoot || document;
        const optBox = root.querySelector('input[placeholder*="搜索歌名"]')?.closest(".link-list-options");
        if (optBox && getComputedStyle(optBox).display !== "none" && optBox.getBoundingClientRect().height > 10) {
          root.querySelector(".bgm-form-content-wrap")?.closest(".link-display-wrap")?.click();
        }
      });
      await page.waitForTimeout(350);
    }
    await muteAndPausePage(page);

    // 5. 保存草稿（视频标注留到 Pass 2 复查草稿箱后在原页最后设置）
    step = "save_draft";
    const saveRect = await page.evaluate(() => {
      const root = document.querySelector("wujie-app")?.shadowRoot || document;
      const btn = [...root.querySelectorAll("button")].find(
        (b) => (b.innerText || "").trim() === "保存草稿" && b.getBoundingClientRect().height > 0
      );
      if (!btn) return null;
      btn.scrollIntoView({ block: "center" });
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    if (!saveRect) throw new Error("未找到微信视频号图文「保存草稿」按钮");
    await page.waitForTimeout(250);
    await page.mouse.click(saveRect.x, saveRect.y, { label: "save WeChat image draft" });
    await page.waitForTimeout(3500);

    const bgmNow = await page.evaluate(() => {
      const root = document.querySelector("wujie-app")?.shadowRoot || document;
      return (root.querySelector(".bgm-form-content-wrap")?.innerText || "").replace(/\s+/g, " ").trim();
    });

    return { status: "ok", musicLog, bgmNow };
  } catch (err) {
    return makeFallback(step, err, await collectLightDiagnostics(page, true));
  }
}

export async function wechatImageVerifyAndLabel(task, origPage, job) {
  let step = "draft_list_check";
  let tempPage = null;
  try {
    const titlePrefix = job.wechat.title.slice(0, 10);
    tempPage = await task.newPage();
    await bringToFront(tempPage);
    await tempPage.goto(WECHAT_DRAFT_LIST_URL, { timeout: 25000 });
    await tempPage
      .waitForFunction(
        (prefix) => {
          const w = document.querySelector("wujie-app")?.shadowRoot;
          return !!w && (w.body?.innerText || "").includes(prefix);
        },
        titlePrefix,
        { timeout: 15000 }
      )
      .catch(() => {});
    await tempPage.waitForTimeout(1000);

    const listCheck = await tempPage.evaluate((prefix) => {
      const root = document.querySelector("wujie-app")?.shadowRoot || document;
      const txt = (root.body?.innerText || "").replace(/\s+/g, " ");
      return { found: txt.includes(prefix), head: txt.slice(0, 320) };
    }, titlePrefix);

    await tempPage.close();
    tempPage = null;

    // 回到原编辑页最后设置「视频标注」（设完绝不再点保存草稿）
    step = "set_video_label";
    const targetLabel = job.aiGenerated ? "含AI生成内容" : "无需标注";
    await bringToFront(origPage);
    await muteAndPausePage(origPage);

    const labelTrig = await origPage.evaluate(() => {
      const root = document.querySelector("wujie-app")?.shadowRoot || document;
      const el = [...root.querySelectorAll("div, button, span")].find(
        (n) =>
          n.children.length === 0 &&
          ["选择视频标注", "无需标注", "含AI生成内容"].includes((n.textContent || "").trim()) &&
          n.getBoundingClientRect().height > 0
      );
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = (el.parentElement || el).getBoundingClientRect();
      return { current: el.textContent.trim(), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    if (!labelTrig) throw new Error("未在微信视频号图文原页找到「视频标注」触发器");

    if (labelTrig.current !== targetLabel) {
      await origPage.waitForTimeout(250);
      await origPage.mouse.click(labelTrig.x, labelTrig.y, { label: "open WeChat image video label" });
      await origPage.waitForTimeout(700);
      const optRect = await origPage.evaluate((lbl) => {
        const root = document.querySelector("wujie-app")?.shadowRoot || document;
        const cands = [...root.querySelectorAll("li, div, span")]
          .filter((el) => {
            const t = (el.innerText || "").trim();
            const r = el.getBoundingClientRect();
            return r.width > 30 && r.height >= 18 && r.height <= 65 && t === lbl;
          })
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), area: r.width * r.height };
          })
          .sort((a, b) => a.area - b.area);
        return cands[0] || null;
      }, targetLabel);
      if (!optRect) throw new Error(`未在微信视频号图文标注菜单中找到「${targetLabel}」`);
      await origPage.mouse.click(optRect.x, optRect.y, { label: `select WeChat image ${targetLabel}` });
      await origPage.waitForTimeout(600);
    }

    step = "verify_orig_page";
    const origPageFinal = await origPage.evaluate((lbl) => {
      const root = document.querySelector("wujie-app")?.shadowRoot || document;
      const bodyText = (root.body?.innerText || "").replace(/\s+/g, " ");
      const title = root.querySelector('input[placeholder*="填写标题"]')?.value || "";
      const ed = root.querySelector("div.input-editor");
      const hl = [...(ed?.querySelectorAll("span.hl.topic, .topic") || [])].map((e) => e.textContent?.trim());
      const pos = (
        root.querySelector(".post-position-wrap .location-name, .post-position-wrap")?.innerText || ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
      const bgm = (root.querySelector(".bgm-form-content-wrap")?.innerText || "").replace(/\s+/g, " ").trim();
      const img = root.querySelector("img.slider-img");
      return {
        url: location.href,
        title,
        descLen: (ed?.innerText || "").trim().length,
        hl,
        pos,
        bgm,
        img: img ? { nw: img.naturalWidth, nh: img.naturalHeight } : null,
        hasTargetLabel: bodyText.includes(lbl),
        hasPlaceholderLabel: bodyText.includes("选择视频标注"),
        hasNoActivity: bodyText.includes("不参与活动"),
      };
    }, targetLabel);

    const issues = [];
    if (!listCheck.found) issues.push("视频号草稿箱列表未查到本条图文草稿");
    if (origPageFinal.title !== job.wechat.title) issues.push(`视频号图文标题不一致: "${origPageFinal.title}"`);
    const expectedLoc = job.wechat.location || WECHAT_NO_LOCATION;
    if (!origPageFinal.pos.includes(expectedLoc)) issues.push(`位置不符: 期望「${expectedLoc}」，实际「${origPageFinal.pos}」`);
    if (!origPageFinal.img || origPageFinal.img.nw < 100) issues.push("原页未检测到有效已上传图文图片");
    if (!job.allowActivities && !origPageFinal.hasNoActivity) issues.push("视频号活动字段未保持「不参与活动」");
    if (!origPageFinal.hasTargetLabel || origPageFinal.hasPlaceholderLabel) {
      issues.push(`原编辑页视频标注未正确设为「${targetLabel}」`);
    }

    return {
      status: issues.length ? "needs_agent_fallback" : "ok",
      failedStep: issues.length ? "verify" : null,
      issues,
      listCheck,
      origPageFinal,
    };
  } catch (err) {
    if (tempPage) await tempPage.close().catch(() => {});
    return makeFallback(step, err, await collectLightDiagnostics(origPage, true));
  }
}

// ============================================================================
// 4. 可选：X 原生图文发帖（x.com/compose/post）与 B 站图文动态（t.bilibili.com）
// ============================================================================

export async function xImageInspectAndInject(page, job) {
  await bringToFront(page);
  await page.waitForSelector('input[data-testid="fileInput"]', { state: "attached", timeout: 15000 }).catch(() => {});
  const info = await page.evaluate(() => ({
    url: location.href,
    hasFileInput: !!document.querySelector('input[data-testid="fileInput"]'),
    needLogin: location.href.includes("/login") || location.href.includes("/flow/login"),
  }));
  if (info.needLogin || !info.hasFileInput) {
    return makeHandoff("login", "X 未登录或未加载撰写弹窗，请先登录。", { info });
  }
  const paths = getImagePaths(job).slice(0, 4); // X 单帖最多 4 图
  await page.setInputFiles('input[data-testid="fileInput"] >> nth=0', paths);
  await page.waitForTimeout(2000);
  return { status: "injected", imageCount: paths.length };
}

export async function xImageFillAndVerify(page, job) {
  let step = "compose";
  try {
    await bringToFront(page);
    if (job.x.tweetText) {
      const hasText = await page.evaluate(
        () => (document.querySelector('[data-testid="tweetTextarea_0"]')?.innerText || "").trim().length > 0
      );
      if (!hasText) {
        await page.click('[data-testid="tweetTextarea_0"]', { label: "focus X compose textarea" });
        await page.keyboard.insertText(job.x.tweetText);
        await page.waitForTimeout(400);
      }
    }
    const verified = await page.evaluate(() => ({
      url: location.href,
      text: (document.querySelector('[data-testid="tweetTextarea_0"]')?.innerText || "").trim(),
      attachedMediaCount: document.querySelectorAll('[data-testid="attachments"] img, [role="dialog"] img[src^="blob:"]').length,
    }));
    return { status: "ok", verified };
  } catch (err) {
    return makeFallback(step, err, await collectLightDiagnostics(page));
  }
}

export async function bilibiliDynamicInspectAndInject(page, job) {
  await bringToFront(page);
  const nav = await page
    .fetch("https://api.bilibili.com/x/web-interface/nav", { credentials: "include" })
    .then((r) => {
      const j = JSON.parse(r.body);
      return { isLogin: !!j?.data?.isLogin, uname: j?.data?.uname || "", mid: j?.data?.mid || null };
    })
    .catch((e) => ({ isLogin: false, err: e.message }));
  if (!nav.isLogin) {
    return makeHandoff("login", "B 站动态页登录态无效，请先扫码登录。", { nav });
  }

  const picBtn = await page.evaluate(() => {
    const el = document.querySelector(".bili-dyn-publishing__tools__item.pic");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  if (!picBtn) {
    return makeFallback("inject", "未在 B 站动态页找到图片按钮 .bili-dyn-publishing__tools__item.pic", await collectLightDiagnostics(page));
  }
  const paths = getImagePaths(job).slice(0, 9);
  const cp = page.waitForFileChooser({ timeout: 10000 });
  await page.mouse.click(picBtn.x, picBtn.y, { label: "upload images to Bili dynamic" });
  const chooser = await cp;
  await chooser.setFiles(paths);
  await page.waitForTimeout(2500);
  return { status: "injected", account: `${nav.uname} (mid:${nav.mid})`, imageCount: paths.length };
}

export async function bilibiliDynamicFillAndVerify(page, job) {
  let step = "fill";
  try {
    await bringToFront(page);
    if (job.bilibili.title) {
      await page.fill("input.bili-dyn-publishing__title__input", job.bilibili.title).catch(() => {});
      await page.waitForTimeout(200);
    }
    const edSel = ".bili-dyn-publishing .bili-rich-textarea__inner";
    await page.click(edSel, { label: "focus Bili dynamic body" });
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    const topicLine = (job.bilibili.topics || []).map((t) => `#${t}`).join(" ");
    const fullBody = [job.bilibili.description, topicLine].filter(Boolean).join("\n");
    if (fullBody) {
      await page.keyboard.insertText(fullBody);
      await page.waitForTimeout(300);
    }
    const verified = await page.evaluate(() => ({
      url: location.href,
      title: document.querySelector("input.bili-dyn-publishing__title__input")?.value || "",
      body: (document.querySelector(".bili-dyn-publishing .bili-rich-textarea__inner")?.innerText || "").trim(),
      note: "B 站图文动态无草稿箱，已填好停留在当前动态发布框等待作者手动确认。",
    }));
    return { status: "ok", verified };
  } catch (err) {
    return makeFallback(step, err, await collectLightDiagnostics(page));
  }
}
