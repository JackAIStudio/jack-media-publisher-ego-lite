/**
 * Ego Lite 跨平台复用辅助工具：
 * 严禁包含任何点击最终发布 / 定时发布按钮的逻辑。
 */

export async function bringToFront(page) {
  await page.cdp("Page.bringToFront").catch(() => {});
  await page.waitForTimeout(200);
}

const UNMUTED_SPAWN_URL =
  'data:text/html,<a id="ego-unmuted-spawn" href="about:blank" target="_blank">open</a>';

/**
 * 通过跳板页上的 <a target="_blank"> 弹出原生未静音标签页，避免 Ego Lite 对
 * createTaskSpace(p1) / task.newPage() 硬编码浏览器级标签页静音（且 finish 不解除）的问题。
 * 若偶发弹出失败则自动降级回 task.newPage()，确保不阻断主流程。
 */
export async function spawnUnmutedPage(task, launcherPage) {
  if (!launcherPage) return task.newPage();
  try {
    const ready = await launcherPage
      .evaluate(() => !!document.querySelector("#ego-unmuted-spawn"))
      .catch(() => false);
    if (!ready) {
      await launcherPage.goto(UNMUTED_SPAWN_URL, { timeout: 8000 });
    }
    const popupPromise = launcherPage.waitForEvent("popup", { timeout: 6000 });
    await launcherPage.click("#ego-unmuted-spawn", { label: "spawn unmuted tab" });
    return await popupPromise;
  } catch {
    return task.newPage();
  }
}

/**
 * 将页面内所有 <video>/<audio>（含 wujie-app shadowRoot）设为静音并暂停。
 * 遵循规范：不修改 volume。
 */
export async function muteAndPausePage(page) {
  return page
    .evaluate(() => {
      const visit = (root) => {
        let count = 0;
        for (const m of root.querySelectorAll("video, audio")) {
          m.muted = true;
          try {
            m.pause();
          } catch {}
          count++;
        }
        const w = root.querySelector?.("wujie-app");
        if (w?.shadowRoot) count += visit(w.shadowRoot);
        return count;
      };
      return visit(document);
    })
    .catch(() => 0);
}

/**
 * 交接前恢复媒体：保持 paused = true，同时恢复 muted = false（不改 volume）。
 */
export async function restorePausedUnmuted(page) {
  return page
    .evaluate(() => {
      const visit = (root) => {
        const list = [];
        for (const m of root.querySelectorAll("video, audio")) {
          try {
            m.pause();
          } catch {}
          m.muted = false;
          list.push({ tag: m.tagName, paused: m.paused, muted: m.muted, volume: m.volume });
        }
        const w = root.querySelector?.("wujie-app");
        if (w?.shadowRoot) list.push(...visit(w.shadowRoot));
        return list;
      };
      return visit(document);
    })
    .catch(() => []);
}

/**
 * 失败时采集极轻量 DOM 诊断信息（不截图、不打印整页 snapshot），
 * 供 Agent 接手兜底时立刻看清现场。
 */
export async function collectLightDiagnostics(page, inWujie = false) {
  return page
    .evaluate((useWujie) => {
      const root = useWujie ? document.querySelector("wujie-app")?.shadowRoot || document : document;
      const bodyEl = root.body || root;
      const text = (bodyEl?.innerText || "").replace(/\s+/g, " ");
      const visibleModals = [
        ...root.querySelectorAll(
          '.d-modal, .semi-modal, .bcc-dialog, .weui-desktop-dialog, [role="dialog"]'
        ),
      ]
        .filter((el) => el.getBoundingClientRect().height > 60)
        .map((el) => (el.innerText || "").replace(/\s+/g, " ").slice(0, 180));
      return {
        url: location.href,
        title: document.title,
        hasWujieShadow: !!document.querySelector("wujie-app")?.shadowRoot,
        visibleModals: visibleModals.slice(0, 3),
        textHead: text.slice(0, 260),
      };
    }, inWujie)
    .catch((e) => ({ diagError: e.message }));
}

export function makeFallback(step, err, diagnostics = null, partial = {}) {
  return {
    status: "needs_agent_fallback",
    failedStep: step,
    reason: err instanceof Error ? err.message : String(err),
    diagnostics,
    ...partial,
  };
}

export function makeHandoff(step, reason, details = {}) {
  return {
    status: "needs_user_handoff",
    failedStep: step,
    reason,
    ...details,
  };
}

/**
 * 按成片体积动态计算上传/转码等待超时，避免 100MB+ 大文件或五平台并发上传时过早放弃。
 * 每 50MB 增加 45 秒，默认区间 [minMs, maxMs]。
 */
export function calcUploadTimeoutMs(sizeBytes, minMs = 120000, maxMs = 360000) {
  const mb = Math.max(0, Number(sizeBytes || 0) / (1024 * 1024));
  const estimated = Math.round(minMs + Math.ceil(mb / 50) * 45000);
  return Math.max(minMs, Math.min(maxMs, estimated));
}

/**
 * 核对网页播放器读出的视频时长是否与本地 ffprobe 时长一致（允许少量封装误差）。
 */
export function isDurationMatch(actualSec, expectedSec) {
  const a = Number(actualSec);
  const e = Number(expectedSec);
  if (!Number.isFinite(a) || a <= 0) return false;
  if (!Number.isFinite(e) || e <= 0) return true;
  const tol = Math.max(4, e * 0.1);
  return Math.abs(a - e) <= tol;
}
