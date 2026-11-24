import {
  bringToFront,
  collectLightDiagnostics,
  makeFallback,
  makeHandoff,
  muteAndPausePage,
} from "./utils.mjs";
import { DEFAULT_WECHAT_LOCATION } from "./validate.mjs";

export const WECHAT_URL = "https://channels.weixin.qq.com/platform/post/create";
export const WECHAT_DRAFT_LIST_URL = "https://channels.weixin.qq.com/platform/post/draftListManager";

/**
 * 阶段 1a：检查 wujie-app shadowRoot 与登录态，注入视频并短切前台触发本地元数据读取。
 */
export async function wechatInspectAndInject(page, job) {
  await page
    .waitForFunction(
      () => {
        const sr = document.querySelector("wujie-app")?.shadowRoot;
        return !!(sr && sr.querySelector('input[type="file"]'));
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
    const inputs = sr
      ? [...sr.querySelectorAll('input[type="file"]')].map((el, i) => ({ i, accept: el.accept || "" }))
      : [];
    return { url: location.href, user, hasShadow: !!sr, inputs };
  });

  if (!info.url.includes("channels.weixin.qq.com/platform/post/create") || !info.hasShadow) {
    return makeHandoff("login", "微信视频号未登录或 wujie 表单未加载，请先扫码登录。", { info });
  }

  const vIdx = info.inputs.findIndex((x) => x.accept.includes("video"));
  const sel = vIdx >= 0 ? `input[type="file"] >> nth=${vIdx}` : 'input[type="file"] >> nth=0';
  await page.setInputFiles(sel, [job.video.path]);
  // 激活页面防止后台页签 readyState === 0
  await bringToFront(page);
  await page.waitForTimeout(1500);
  await muteAndPausePage(page);
  return { status: "injected", user: info.user };
}

/**
 * 阶段 1b：等上传转码解锁 -> 填描述/短标题/位置（默认「温州世贸大厦」）/原创 -> 按页面实际卡片传封面 -> 保存草稿（视频标注留到 Pass 2）。
 */
export async function wechatFillAndSave(page, job) {
  let step = "wait_unlock";
  try {
    await bringToFront(page);
    await muteAndPausePage(page);

    await page
      .waitForFunction(
        () => {
          const root = document.querySelector("wujie-app")?.shadowRoot;
          if (!root) return false;
          const txt = root.body?.innerText || "";
          const ed = root.querySelector("div.input-editor");
          const locked =
            txt.includes("文件上传中") || txt.includes("转码中") || txt.includes("取消上传") || txt.includes("处理中");
          return !!ed && !locked;
        },
        undefined,
        { timeout: 60000 }
      )
      .catch(() => {});
    await muteAndPausePage(page);

    const stillLocked = await page.evaluate(() => {
      const root = document.querySelector("wujie-app")?.shadowRoot;
      const txt = root?.body?.innerText || "";
      return txt.includes("文件上传中") || txt.includes("转码中") || txt.includes("取消上传");
    });
    if (stillLocked) {
      return makeFallback("wait_unlock", "微信视频号仍在上传或转码锁定中，稍后再试或由 Agent 接手等待。", await collectLightDiagnostics(page, true));
    }

    // 1. 视频描述（原标题 + #话题）与可选短标题
    step = "description";
    await page.click("div.input-editor", { label: "focus WeChat desc" });
    await page.waitForTimeout(250);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.keyboard.insertText(job.wechat.description);
    await page.waitForTimeout(700);

    if (job.wechat.shortTitle) {
      const shortSel = 'input[placeholder*="概括视频主要内容"], input[placeholder*="短标题"]';
      await page.fill(shortSel, job.wechat.shortTitle).catch(() => {});
    }

    // 2. 位置（默认设为「温州世贸大厦」；支持「不显示位置」、城市名或任意 POI 关键词搜索并精确选中）
    step = "location";
    const targetLoc = job.wechat.location || DEFAULT_WECHAT_LOCATION;
    const searchLocQuery = job.wechat.locationQuery || targetLoc;
    const currentLoc = await page.evaluate(() => {
      const root = document.querySelector("wujie-app")?.shadowRoot || document;
      root.querySelector(".post-position-wrap")?.scrollIntoView({ block: "center" });
      return (root.querySelector(".post-position-wrap .location-name")?.innerText || "").trim();
    });
    await page.waitForTimeout(250);

    if (currentLoc !== targetLoc) {
      await page.click(".post-position-wrap .position-display", { label: "open WeChat location" }).catch(async () => {
        await page.click(".post-position-wrap .location-name", { label: "open WeChat location name" }).catch(async () => {
          await page.click(".post-position-wrap", { label: "open WeChat location wrap" });
        });
      });
      await page.waitForTimeout(650);

      if (targetLoc === "不显示位置") {
        try {
          await page.click('text="不显示位置"', { label: "select WeChat 不显示位置", timeout: 4000 });
        } catch {
          await page.evaluate(() => {
            const root = document.querySelector("wujie-app")?.shadowRoot || document;
            const item = [...root.querySelectorAll(".location-filter-wrap .option-item")].find(
              (el) => (el.querySelector(".name")?.innerText || el.innerText || "").trim() === "不显示位置"
            );
            item?.click();
          });
        }
      } else {
        // 先检查默认列表是否已含精确项；若无则走「搜索附近位置」输入框查询
        const alreadyInInitialList = await page.evaluate((loc) => {
          const root = document.querySelector("wujie-app")?.shadowRoot || document;
          return [...root.querySelectorAll(".location-filter-wrap .option-item")].some(
            (el) =>
              el.getBoundingClientRect().height > 0 &&
              (el.querySelector(".name")?.innerText || "").trim() === loc
          );
        }, targetLoc);

        if (!alreadyInInitialList) {
          const searchSel = '.location-filter-wrap input[placeholder*="搜索附近位置"]';
          await page.fill(searchSel, searchLocQuery);
          await page.waitForTimeout(250);
          await page.click(".location-filter-wrap .weui-desktop-search__btn", {
            label: `search WeChat POI ${searchLocQuery}`,
          }).catch(async () => {
            await page.keyboard.press("Enter");
          });
          await page
            .waitForFunction(
              (loc) => {
                const root = document.querySelector("wujie-app")?.shadowRoot || document;
                return [...root.querySelectorAll(".location-filter-wrap .option-item")].some(
                  (el) =>
                    el.getBoundingClientRect().height > 0 &&
                    (el.querySelector(".name")?.innerText || "").trim() === loc
                );
              },
              targetLoc,
              { timeout: 8000 }
            )
            .catch(() => {});
          await page.waitForTimeout(400);
        }

        // 严格按 .option-item .name 精确匹配点击，防止误点同前缀商铺或停车场
        const picked = await page.evaluate((loc) => {
          const root = document.querySelector("wujie-app")?.shadowRoot || document;
          const items = [...root.querySelectorAll(".location-filter-wrap .option-item")].filter(
            (el) => el.getBoundingClientRect().height > 0
          );
          const exact = items.find((el) => (el.querySelector(".name")?.innerText || "").trim() === loc);
          if (exact) {
            exact.scrollIntoView({ block: "nearest" });
            const r = exact.getBoundingClientRect();
            return {
              found: true,
              name: (exact.querySelector(".name")?.innerText || "").trim(),
              x: Math.round(r.left + Math.min(80, r.width / 2)),
              y: Math.round(r.top + r.height / 2),
            };
          }
          return {
            found: false,
            candidates: items.slice(0, 8).map((el) => (el.querySelector(".name")?.innerText || "").trim()),
          };
        }, targetLoc);

        if (!picked.found) {
          throw new Error(
            `微信视频号位置搜索「${searchLocQuery}」未找到精确匹配「${targetLoc}」的 POI（候选前 8 项: ${(picked.candidates || []).join("、") || "空"}）`
          );
        }
        await page.mouse.click(picked.x, picked.y, { label: `select WeChat POI ${targetLoc}` });
        await page.waitForTimeout(600);
      }

      // 回读确认并确保下拉面板已收起
      const locCheck = await page.evaluate(() => {
        const root = document.querySelector("wujie-app")?.shadowRoot || document;
        const wrap = root.querySelector(".location-filter-wrap");
        const displayed = (root.querySelector(".post-position-wrap .location-name")?.innerText || "").trim();
        const stillOpen = !!wrap && getComputedStyle(wrap).display !== "none";
        return { displayed, stillOpen };
      });
      if (locCheck.stillOpen) {
        await page.click(".post-position-wrap .position-display", { label: "close WeChat location dropdown" }).catch(() => {});
        await page.waitForTimeout(300);
      }
      if (!locCheck.displayed.includes(targetLoc)) {
        throw new Error(`微信视频号位置设置未生效：期望「${targetLoc}」，当前显示「${locCheck.displayed}」`);
      }
    }
    await page.waitForTimeout(350);

    // 3. 声明原创（只查 height > 80 的可见弹窗，防止命中隐藏「保留编辑」dialog）
    step = "original";
    if (job.original) {
      const origChecked = await page.evaluate(() => {
        const root = document.querySelector("wujie-app")?.shadowRoot || document;
        const orig = root.querySelector(".declare-original-checkbox");
        orig?.scrollIntoView({ block: "center" });
        return !!orig?.querySelector('input[type="checkbox"]')?.checked;
      });
      await page.waitForTimeout(250);
      if (!origChecked) {
        const cbRect = await page.evaluate(() => {
          const root = document.querySelector("wujie-app")?.shadowRoot || document;
          const el = root.querySelector(
            ".declare-original-checkbox .ant-checkbox-inner, .declare-original-checkbox label, .declare-original-checkbox"
          );
          const r = el?.getBoundingClientRect();
          return r ? { x: Math.round(r.left + Math.min(12, r.width / 2)), y: Math.round(r.top + r.height / 2) } : null;
        });
        if (cbRect) {
          await page.mouse.click(cbRect.x, cbRect.y, { label: "check WeChat original" });
          await page.waitForTimeout(900);
        }
        const dlgInfo = await page.evaluate(() => {
          const root = document.querySelector("wujie-app")?.shadowRoot || document;
          const dlgs = [...root.querySelectorAll(".declare-original-dialog, .weui-desktop-dialog")].filter(
            (d) => d.getBoundingClientRect().height > 80
          );
          const dlg = dlgs[dlgs.length - 1];
          if (!dlg) return null;
          const cbs = [...dlg.querySelectorAll('input[type="checkbox"], .ant-checkbox-inner, .weui-desktop-icon-checkbox')]
            .map((c) => {
              const r = c.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) };
            })
            .filter((c) => c.w > 0);
          const btns = [...dlg.querySelectorAll("button, a")]
            .map((b) => {
              const r = b.getBoundingClientRect();
              return {
                text: (b.innerText || "").trim(),
                x: Math.round(r.left + r.width / 2),
                y: Math.round(r.top + r.height / 2),
                w: Math.round(r.width),
              };
            })
            .filter((b) => b.w > 20);
          return {
            cb: cbs[0] || null,
            confirm: btns.find((b) => b.text.includes("声明原创") || b.text.includes("确定") || b.text.includes("确认")) || null,
          };
        });
        if (dlgInfo?.cb) {
          await page.mouse.click(dlgInfo.cb.x, dlgInfo.cb.y, { label: "agree WeChat original" });
          await page.waitForTimeout(450);
        }
        if (dlgInfo?.confirm) {
          await page.mouse.click(dlgInfo.confirm.x, dlgInfo.confirm.y, { label: "confirm WeChat original" });
          await page.waitForTimeout(700);
        }
      }
    }

    // 4. 封面：按主页面实际可见卡片逐卡上传（竖屏仅 1 张 3:4；横屏有 3:4 主页 + 4:3 分享）
    step = "covers";
    const clickOrangeConfirm = async (labelText) => {
      const rect = await page.evaluate(() => {
        const root = document.querySelector("wujie-app")?.shadowRoot || document;
        const btns = [
          ...root.querySelectorAll(".weui-desktop-dialog__ft button, .weui-desktop-dialog__ft a, .weui-desktop-dialog button"),
        ];
        for (const b of btns) {
          const t = (b.innerText || b.textContent || "").trim();
          const r = b.getBoundingClientRect();
          // 严格只点可见的橙色主按钮「确认」，绝不误点隐藏的「确定」
          if (t === "确认" && r.width > 40 && r.height > 20 && r.y > 0) {
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
        }
        return null;
      });
      if (!rect) return false;
      await page.mouse.click(rect.x, rect.y, { label: labelText });
      await page.waitForTimeout(2800);
      return true;
    };

    const uploadCard = async (wrapSel, filePath, tag) => {
      const present = await page.evaluate((sel) => {
        const root = document.querySelector("wujie-app")?.shadowRoot || document;
        const w = root.querySelector(sel);
        return !!(w && w.getBoundingClientRect().height > 0);
      }, wrapSel);
      if (!present) return "slot_not_present";
      if (!filePath) return "cover_not_provided";

      await page.evaluate((sel) => {
        const root = document.querySelector("wujie-app")?.shadowRoot || document;
        const wrap = root.querySelector(sel);
        wrap?.scrollIntoView({ block: "center" });
        const btn =
          wrap?.querySelector(".edit-btn") ||
          [...(wrap?.querySelectorAll("*") || [])].find((el) => (el.textContent || "").trim() === "编辑");
        if (btn) btn.click();
      }, wrapSel);
      await page.waitForTimeout(1200);

      // 处理「使用此素材作为封面？」->「直接编辑」
      const directEdit = await page.evaluate(() => {
        const root = document.querySelector("wujie-app")?.shadowRoot || document;
        const btn = [...root.querySelectorAll("button, a, div, span")].find(
          (el) => (el.textContent || "").trim() === "直接编辑" && el.getBoundingClientRect().height > 0
        );
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      if (directEdit) {
        await page.mouse.click(directEdit.x, directEdit.y, { label: `WeChat direct edit ${tag}` });
        await page.waitForTimeout(1000);
      }

      await page.setInputFiles('.single-cover-uploader-wrap input[type="file"]', [filePath]);
      await page.waitForTimeout(2200);
      const ok = await clickOrangeConfirm(`confirm WeChat ${tag} cover`);
      if (!ok) throw new Error(`微信视频号 ${tag} 封面弹窗未找到橙色「确认」按钮`);
      return "confirmed";
    };

    const coverLog = {
      v3x4: await uploadCard(".vertical-img-wrap", job.wechat.cover3x4, "3:4"),
      h4x3: await uploadCard(".horizon-img-wrap", job.wechat.cover4x3, "4:3"),
    };

    // 5. 保存草稿（视频标注按规范留到 Pass 2 复查草稿后在原编辑页最后设置）
    step = "save_draft";
    await page.evaluate(() => {
      const root = document.querySelector("wujie-app")?.shadowRoot || document;
      const btn = [...root.querySelectorAll("button")].find((b) => (b.innerText || "").trim() === "保存草稿");
      btn?.scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(300);
    const saveRect = await page.evaluate(() => {
      const root = document.querySelector("wujie-app")?.shadowRoot || document;
      const btn = [...root.querySelectorAll("button")].find((b) => (b.innerText || "").trim() === "保存草稿");
      const r = btn?.getBoundingClientRect();
      return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
    });
    if (!saveRect) throw new Error("未找到微信视频号「保存草稿」按钮");
    await page.mouse.click(saveRect.x, saveRect.y, { label: "save WeChat draft" });
    await page.waitForTimeout(3500);

    const afterSave = await page.evaluate(() => {
      const root = document.querySelector("wujie-app")?.shadowRoot || document;
      const txt = (root.body?.innerText || "").replace(/\s+/g, " ");
      const pos = (
        root.querySelector(".post-position-wrap .location-name")?.innerText ||
        root.querySelector(".post-position-wrap")?.innerText ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
      return { hasSaved: txt.includes("已保存") || txt.includes("保存成功"), pos };
    });

    return { status: "ok", coverLog, afterSave };
  } catch (err) {
    return makeFallback(step, err, await collectLightDiagnostics(page, true));
  }
}

/**
 * 阶段 2：
 * 1) 另开临时标签页访问 draftListManager 复查草稿（尝试打开核对并关闭临时页）；
 * 2) 回到原编辑页最后设置「视频标注」（含AI生成内容 / 无需标注），设完绝不再点保存草稿。
 */
export async function wechatVerifyAndLabel(task, origPage, job) {
  let step = "draft_list_check";
  let tempPage = null;
  try {
    const titlePrefix = job.title.slice(0, 10);
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
    await tempPage.waitForTimeout(800);

    const listMatch = await tempPage.evaluate((prefix) => {
      const root = document.querySelector("wujie-app")?.shadowRoot || document;
      const cards = [...root.querySelectorAll("div, li")]
        .filter((el) => {
          const t = (el.innerText || "").replace(/\s+/g, " ");
          return t.includes(prefix) && t.length > 20 && t.length < 360;
        })
        .sort((a, b) => (a.innerText?.length || 0) - (b.innerText?.length || 0));
      const card = cards[0];
      if (!card) return { found: false };
      const r = card.getBoundingClientRect();
      return {
        found: true,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        text: (card.innerText || "").replace(/\s+/g, " ").slice(0, 200),
      };
    }, titlePrefix);

    let draftReopened = null;
    if (listMatch.found) {
      await tempPage.mouse.move(listMatch.x, listMatch.y, { label: "hover WeChat draft item" });
      await tempPage.waitForTimeout(500);
      await tempPage.evaluate((prefix) => {
        const root = document.querySelector("wujie-app")?.shadowRoot || document;
        const cards = [...root.querySelectorAll("div, li")]
          .filter((el) => {
            const t = (el.innerText || "").replace(/\s+/g, " ");
            return t.includes(prefix) && t.length > 20 && t.length < 360;
          })
          .sort((a, b) => (a.innerText?.length || 0) - (b.innerText?.length || 0));
        let cur = cards[0];
        for (let i = 0; i < 4 && cur; i++) {
          const btn = [...cur.querySelectorAll("a, button, span, div")].find((x) =>
            ["编辑", "继续编辑"].includes((x.textContent || "").trim())
          );
          if (btn) {
            btn.click();
            return;
          }
          cur = cur.parentElement;
        }
      }, titlePrefix);
      await tempPage
        .waitForFunction(
          () => {
            const w = document.querySelector("wujie-app")?.shadowRoot;
            return !!w && !!w.querySelector("div.input-editor");
          },
          undefined,
          { timeout: 8000 }
        )
        .catch(() => {});
      await tempPage.waitForTimeout(1500);
      draftReopened = await tempPage.evaluate(() => {
        const root = document.querySelector("wujie-app")?.shadowRoot || document;
        for (const m of root.querySelectorAll("video, audio")) {
          m.muted = true;
          try {
            m.pause();
          } catch {}
        }
        const ed = root.querySelector("div.input-editor");
        if (!ed) return { openedEditor: false };
        const pos = (
          root.querySelector(".post-position-wrap .location-name")?.innerText ||
          root.querySelector(".post-position-wrap")?.innerText ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 40);
        return {
          openedEditor: true,
          desc: ed.innerText?.trim(),
          pos,
          orig: !!root.querySelector('.declare-original-checkbox input[type="checkbox"]')?.checked,
        };
      });
    }
    await tempPage.close();
    tempPage = null;

    // 回到原编辑页设置最终「视频标注」（设完绝不点保存草稿！）
    step = "set_video_label";
    const targetLabel = job.aiGenerated ? "含AI生成内容" : "无需标注";
    await bringToFront(origPage);

    const alreadySet = await origPage.evaluate((lbl) => {
      const root = document.querySelector("wujie-app")?.shadowRoot || document;
      const txt = root.body?.innerText || "";
      return txt.includes(lbl) && !txt.includes("选择视频标注");
    }, targetLabel);

    if (!alreadySet) {
      await origPage.evaluate(() => {
        const root = document.querySelector("wujie-app")?.shadowRoot || document;
        const el = [...root.querySelectorAll("div, button, span")].find((n) =>
          ["选择视频标注", "含AI生成内容", "无需标注"].includes((n.innerText || n.textContent || "").trim())
        );
        el?.scrollIntoView({ block: "center" });
      });
      await origPage.waitForTimeout(350);
      const triggerRect = await origPage.evaluate(() => {
        const root = document.querySelector("wujie-app")?.shadowRoot || document;
        const el = [...root.querySelectorAll("div, button, span")].find(
          (n) =>
            n.children.length === 0 &&
            ["选择视频标注", "含AI生成内容", "无需标注"].includes((n.textContent || "").trim())
        );
        const r = (el?.parentElement || el)?.getBoundingClientRect();
        return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
      });
      if (!triggerRect) throw new Error("未在原编辑页找到「视频标注」下拉触发器");
      await origPage.mouse.click(triggerRect.x, triggerRect.y, { label: "open WeChat video label menu" });
      await origPage.waitForTimeout(650);

      const optRect = await origPage.evaluate((lbl) => {
        const root = document.querySelector("wujie-app")?.shadowRoot || document;
        const opts = [...root.querySelectorAll("li, div, span")]
          .filter((el) => {
            const t = (el.innerText || "").trim();
            const r = el.getBoundingClientRect();
            return r.width > 40 && r.height >= 20 && r.height <= 60 && (t === lbl || t.includes(lbl));
          })
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), area: r.width * r.height };
          })
          .sort((a, b) => a.area - b.area);
        return opts[0] || null;
      }, targetLabel);
      if (!optRect) throw new Error(`未在微信视频标注菜单中找到「${targetLabel}」`);
      await origPage.mouse.click(optRect.x, optRect.y, { label: `select WeChat ${targetLabel}` });
      await origPage.waitForTimeout(600);
    }

    step = "verify_orig_page";
    const origPageFinal = await origPage.evaluate((lbl) => {
      const root = document.querySelector("wujie-app")?.shadowRoot || document;
      const bodyText = (root.body?.innerText || "").replace(/\s+/g, " ");
      const ed = root.querySelector("div.input-editor");
      const hl = [...(ed?.querySelectorAll("span.hl.topic, .topic") || [])].map((el) => el.textContent?.trim());
      const pos = (
        root.querySelector(".post-position-wrap .location-name")?.innerText ||
        root.querySelector(".post-position-wrap")?.innerText ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
      const orig = !!root.querySelector('.declare-original-checkbox input[type="checkbox"]')?.checked;
      const shortTitle =
        root.querySelector('input[placeholder*="概括视频主要内容"], input[placeholder*="短标题"]')?.value || "";
      const linkedActivities = [];
      const actLabel = [...root.querySelectorAll("div, span, label, p")].find(
        (el) =>
          el.children.length === 0 &&
          (el.innerText || el.textContent || "").trim() === "活动" &&
          el.getBoundingClientRect().height > 0
      );
      if (actLabel) {
        let row = actLabel.parentElement;
        for (let i = 0; i < 4 && row; i++) {
          const r = row.getBoundingClientRect();
          if (r.width > 180 && r.height >= 24 && r.height <= 140) break;
          row = row.parentElement;
        }
        if (row) {
          const val = (row.innerText || "")
            .replace(/^活动/, "")
            .replace(/\s+/g, " ")
            .trim();
          const placeholders = new Set(["", "添加活动", "选择活动", "请选择活动", "不参与", "暂不参与", "不参与活动"]);
          if (val && !placeholders.has(val) && !/^(添加|选择|请选择)活动/.test(val)) {
            linkedActivities.push(val.slice(0, 60));
          }
        }
      }
      const probe = (sel) => {
        const w = root.querySelector(sel);
        if (!w || w.getBoundingClientRect().height === 0) return null;
        const img = w.querySelector("img");
        return img
          ? {
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
            }
          : { noImg: true };
      };
      return {
        desc: ed?.innerText?.trim() || "",
        hl,
        shortTitle,
        pos,
        orig,
        linkedActivities,
        v3x4: probe(".vertical-img-wrap"),
        h4x3: probe(".horizon-img-wrap"),
        hasTargetLabel: bodyText.includes(lbl),
        hasPlaceholderLabel: bodyText.includes("选择视频标注"),
      };
    }, targetLabel);

    const issues = [];
    if (!listMatch.found) issues.push("草稿箱列表未查到本条草稿");
    const expectedLoc = job.wechat.location || DEFAULT_WECHAT_LOCATION;
    if (!origPageFinal.pos.includes(expectedLoc)) {
      issues.push(`位置不符: 期望「${expectedLoc}」，实际「${origPageFinal.pos}」`);
    }
    if (job.original && !origPageFinal.orig) issues.push("原创声明未勾选");
    if (!job.allowActivities && origPageFinal.linkedActivities?.length > 0) {
      issues.push(`微信视频号存在未授权关联活动: ${origPageFinal.linkedActivities.join("、")}`);
    }
    if (!origPageFinal.hasTargetLabel || origPageFinal.hasPlaceholderLabel) {
      issues.push(`原编辑页视频标注未正确设为「${targetLabel}」`);
    }

    return {
      status: issues.length ? "needs_agent_fallback" : "ok",
      failedStep: issues.length ? "verify" : null,
      issues,
      listMatch,
      draftReopened,
      origPageFinal,
    };
  } catch (err) {
    if (tempPage) await tempPage.close().catch(() => {});
    return makeFallback(step, err, await collectLightDiagnostics(origPage, true));
  }
}
